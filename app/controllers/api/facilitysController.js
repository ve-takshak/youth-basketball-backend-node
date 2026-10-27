const validator = require("validator");
const Club = require("../../models/Club");
const Facility = require("../../models/Facility");
const { FACILITY_TYPES } = require("../../models/Facility");
const { ROLES } = require("../../helpers/constants");
const { isValidId, cleanMobile, escapeRegex, getPagination } = require("../../helpers/common");

// Facilities (hall / court / gym) ka CRUD. superAdmin sab clubs ki, clubAdmin sirf apne club ki.
//   POST   /user/facilities/create
//   GET    /user/facilities
//   GET    /user/facilities/:id
//   PUT    /user/facilities/:id/update
//   DELETE /user/facilities/:id/delete

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendServerError = (res, label, e) => {
    console.error(`${label} error:`, e);
    return res.status(500).json({
        error: true,
        status: 500,
        message: "Something went wrong.",
        message_desc: e.message,
        data: {},
    });
};

// clubAdmin sirf apne club ki facility chhu sakta hai. superAdmin sab.
const canAccess = (req, clubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(clubId?._id || clubId);

// Frontend ke liye flat object
const formatFacility = (facility) => ({
    _id: facility._id,
    name: facility.name,
    address: facility.address || "",
    type: facility.type,
    parallelUnits: facility.parallelUnits ?? 1,
    hallManager: {
        name: facility.hallManager?.name || "",
        countryCode: facility.hallManager?.phone ? facility.hallManager.countryCode || "+972" : "",
        phone: facility.hallManager?.phone || "",
        email: facility.hallManager?.email || "",
    },
    club: facility.clubId && facility.clubId._id ? { _id: facility.clubId._id, name: facility.clubId.name } : null,
    createdAt: facility.createdAt,
    updatedAt: facility.updatedAt,
});

/**
 * Body check. partial = update (sirf bheje gaye fields).
 * Hall manager do tarah se aa sakta hai:
 *   JSON:       { hallManager: { name, countryCode, phone, email } }
 *   form-data:  hallManagerName, hallManagerCountryCode, hallManagerPhone, hallManagerEmail
 * Galti ho toh { message }, warna { values }
 */
const validateFacility = (body, partial = false) => {
    body = body || {};
    const v = {};
    const has = (key) => body[key] !== undefined;

    if (!partial || has("name")) {
        v.name = String(body.name ?? "").trim();
        if (!v.name) return { message: "Facility name is required." };
        if (v.name.length > 100) return { message: "Facility name must be 100 characters or less." };
    }

    if (!partial || has("address")) {
        v.address = String(body.address ?? "").trim();
        if (v.address.length > 300) return { message: "Address must be 300 characters or less." };
    }

    if (!partial || has("type")) {
        v.type = String(body.type || "indoor_hall").trim().toLowerCase();
        if (!FACILITY_TYPES.includes(v.type)) {
            return { message: `Type must be one of: ${FACILITY_TYPES.join(", ")}.` };
        }
    }

    if (!partial || has("parallelUnits")) {
        const raw = body.parallelUnits;
        const units = raw === undefined || raw === null || raw === "" ? 1 : Number(raw);
        if (!Number.isInteger(units) || units < 1 || units > 20) {
            return { message: "Parallel units must be a whole number from 1 to 20." };
        }
        v.parallelUnits = units;
    }

    // Hall manager: nested object ya flat form-data keys
    const hm = typeof body.hallManager === "object" && body.hallManager !== null ? body.hallManager : {};
    const pick = (nestedKey, flatKey) => (hm[nestedKey] !== undefined ? hm[nestedKey] : body[flatKey]);
    const managerSent =
        body.hallManager !== undefined ||
        ["hallManagerName", "hallManagerCountryCode", "hallManagerPhone", "hallManagerEmail"].some(has);

    if (!partial || managerSent) {
        // Edit mein sirf wahi subfields jo bheje gaye (baaki purane rahenge)
        const sent = (nestedKey, flatKey) => !partial || pick(nestedKey, flatKey) !== undefined;
        const manager = {};

        if (sent("name", "hallManagerName")) {
            manager.name = String(pick("name", "hallManagerName") ?? "").trim();
        }
        if (sent("countryCode", "hallManagerCountryCode")) {
            manager.countryCode = String(pick("countryCode", "hallManagerCountryCode") || "+972").trim();
        }
        if (sent("phone", "hallManagerPhone")) {
            manager.phone = cleanMobile(pick("phone", "hallManagerPhone"));
            if (manager.phone && manager.phone.length < 7) return { message: "Hall manager phone is not valid." };
        }
        if (sent("email", "hallManagerEmail")) {
            manager.email = String(pick("email", "hallManagerEmail") ?? "").trim().toLowerCase();
            if (manager.email && !validator.isEmail(manager.email)) return { message: "Hall manager email is not valid." };
        }

        v.hallManager = manager;
    }

    return { values: v };
};

// Same club mein same naam ki facility? (capital / small ek jaisa)
const nameTaken = (clubId, name, excludeId = null) =>
    Facility.exists({
        clubId,
        name: new RegExp(`^${escapeRegex(name)}$`, "i"),
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });

// Facility id valid + access. Galti ho toh { status, message }
const findFacility = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid facility id." };
    const facility = await Facility.findById(id);
    if (!facility || !canAccess(req, facility.clubId)) return { status: 404, message: "Facility not found." };
    return { facility };
};

/**
 * POST /api/user/facilities/create   (superAdmin ya clubAdmin)
 * body: { name, address?, type?, parallelUnits?, hallManager?: { name, countryCode, phone, email }, clubId (sirf superAdmin) }
 */
const createFacility = async (req, res) => {
    try {
        const body = req.body || {};

        const checked = validateFacility(body);
        if (checked.message) return sendError(res, 400, checked.message);
        const values = checked.values;

        // clubAdmin apne club mein, superAdmin body se club chunega
        const clubId = req.user.role === ROLES.CLUB_ADMIN ? String(req.clubId || "") : String(body.clubId || "").trim();
        if (!isValidId(clubId) || !(await Club.exists({ _id: clubId }))) {
            return sendError(res, 400, "Please select a valid club.");
        }

        if (await nameTaken(clubId, values.name)) {
            return sendError(res, 409, "A facility with this name already exists in this club.");
        }

        const facility = await Facility.create({ ...values, clubId, createdBy: req.user._id });
        const saved = await Facility.findById(facility._id).populate("clubId", "name");

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Facility created successfully.",
            message_desc: "Facility created successfully.",
            data: formatFacility(saved),
        });
    } catch (e) {
        if (e.code === 11000) return sendError(res, 409, "A facility with this name already exists in this club.");
        return sendServerError(res, "Create facility", e);
    }
};

/**
 * GET /api/user/facilities?clubId=&type=&search=&page=1&limit=10   (superAdmin ya clubAdmin)
 * search: facility ka naam, address ya hall manager ka naam
 */
const listFacilities = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const type = String(req.query.type || "").trim().toLowerCase();
        const { page, limit, skip } = getPagination(req.query);

        const filter = {};
        if (req.user.role === ROLES.CLUB_ADMIN) {
            if (!req.clubId) return sendError(res, 403, "Your account is not linked to any club.");
            filter.clubId = req.clubId;
        } else if (clubId) {
            if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
            filter.clubId = clubId;
        }

        if (type) {
            if (!FACILITY_TYPES.includes(type)) return sendError(res, 400, `Type must be one of: ${FACILITY_TYPES.join(", ")}.`);
            filter.type = type;
        }

        if (search) {
            const rx = new RegExp(escapeRegex(search), "i");
            filter.$or = [{ name: rx }, { address: rx }, { "hallManager.name": rx }];
        }

        const [facilities, total] = await Promise.all([
            Facility.find(filter)
                .collation({ locale: "en", strength: 2 }) // A-Z mein capital / small ek jaisa
                .sort({ name: 1 })
                .skip(skip)
                .limit(limit)
                .populate("clubId", "name"),
            Facility.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Facilities fetched successfully.",
            message_desc: "Facilities fetched successfully.",
            data: {
                facilities: facilities.map(formatFacility),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        return sendServerError(res, "List facilities", e);
    }
};

/**
 * GET /api/user/facilities/:id   (superAdmin ya clubAdmin)
 */
const getFacility = async (req, res) => {
    try {
        const found = await findFacility(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);

        await found.facility.populate("clubId", "name");

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Facility fetched successfully.",
            message_desc: "Facility fetched successfully.",
            data: formatFacility(found.facility),
        });
    } catch (e) {
        return sendServerError(res, "Get facility", e);
    }
};

/**
 * PUT /api/user/facilities/:id/update   (superAdmin ya clubAdmin)
 * body: jo badalna hai wahi. hallManager mein bhi sirf bheje gaye fields badalte hain.
 * Club nahi badalta.
 */
const updateFacility = async (req, res) => {
    try {
        const found = await findFacility(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { facility } = found;

        const checked = validateFacility(req.body, true);
        if (checked.message) return sendError(res, 400, checked.message);
        const values = checked.values;

        if (Object.keys(values).length === 0) return sendError(res, 400, "Nothing to update.");

        if (values.name && (await nameTaken(facility.clubId, values.name, facility._id))) {
            return sendError(res, 409, "A facility with this name already exists in this club.");
        }

        // Hall manager: purane ke upar sirf naye fields
        if (values.hallManager) {
            const current = facility.hallManager?.toObject ? facility.hallManager.toObject() : facility.hallManager || {};
            values.hallManager = { ...current, ...values.hallManager };
        }

        Object.assign(facility, values);
        await facility.save();
        await facility.populate("clubId", "name");

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Facility updated successfully.",
            message_desc: "Facility updated successfully.",
            data: formatFacility(facility),
        });
    } catch (e) {
        if (e.code === 11000) return sendError(res, 409, "A facility with this name already exists in this club.");
        return sendServerError(res, "Update facility", e);
    }
};

/**
 * DELETE /api/user/facilities/:id/delete   (superAdmin ya clubAdmin)
 * NOTE: jab schedule / trainings facility use karne lagen, tab yahan check lagana ki facility kahin use toh nahi ho rahi.
 */
const deleteFacility = async (req, res) => {
    try {
        const found = await findFacility(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);

        await Facility.findByIdAndDelete(found.facility._id);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Facility deleted successfully.",
            message_desc: "Facility deleted successfully.",
            data: { _id: found.facility._id },
        });
    } catch (e) {
        return sendServerError(res, "Delete facility", e);
    }
};

module.exports = {
    createFacility,
    listFacilities,
    getFacility,
    updateFacility,
    deleteFacility,
};