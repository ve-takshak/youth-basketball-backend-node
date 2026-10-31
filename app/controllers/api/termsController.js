const Club = require("../../models/Club");
const ClubTerms = require("../../models/ClubTerms");
const TermsAcceptance = require("../../models/TermsAcceptance");
const Parent = require("../../models/Parent");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { getRequiredTerms, hasAcceptedRequired } = require("../../helpers/termsHelper");
const { normalizeDelta } = require("../../helpers/termsDelta");

// Club ki Terms & Conditions (rich text editor ka document, club jis bhasha mein likhe).
//   Likhna / versions dekhna : superAdmin (kisi bhi club ke liye), clubAdmin (sirf apne club ke liye)
//   Padhna + accept karna    : us club ke parents
// Har save ek NAYA version banata hai, purane version kabhi badalte / hat'te nahi (acceptance log ke liye).

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendServerError = (res, label, e) => {
    console.error(`${label} error:`, e);
    return sendError(res, 500, "Something went wrong.");
};

const personName = (user) => (user ? `${user.firstname || ""} ${user.lastname || ""}`.trim() : "");

// superAdmin kisi bhi club ka, clubAdmin sirf apna. { club } ya { status, message }
const findManagedClub = async (req) => {
    const { id } = req.params;
    if (!isValidId(id)) return { status: 400, message: "Invalid club id." };
    if (req.user.role === ROLES.CLUB_ADMIN && String(req.clubId) !== String(id)) {
        return { status: 403, message: "You can only manage terms for your own club." };
    }
    const club = await Club.findById(id).select("_id name");
    if (!club) return { status: 404, message: "Club not found." };
    return { club };
};

const formatVersion = (terms, acceptedCount = 0) => ({
    _id: terms._id,
    version: terms.version,
    requireReaccept: terms.requireReaccept,
    createdAt: terms.createdAt,
    createdBy: personName(terms.createdBy),
    acceptedCount,
    length: terms.plainText.length,
});

/**
 * GET /api/user/clubs/:id/terms   (superAdmin, ya clubAdmin apne club ka)
 * Current terms + saare versions (naya pehle), har version pe kitne parents ne accept kiya.
 * response: { current: { version, content, ... } | null, versions: [...], parentsTotal, requiredVersion }
 */
const listClubTerms = async (req, res) => {
    try {
        const found = await findManagedClub(req);
        if (found.message) return sendError(res, found.status, found.message);
        const clubId = found.club._id;

        const [versions, counts, parentsTotal, required] = await Promise.all([
            ClubTerms.find({ clubId }).sort({ version: -1 }).populate("createdBy", "firstname lastname"),
            TermsAcceptance.aggregate([
                { $match: { clubId } },
                { $group: { _id: "$termsId", count: { $sum: 1 } } },
            ]),
            Parent.countDocuments({ clubId }),
            getRequiredTerms(clubId),
        ]);
        const acceptedBy = new Map(counts.map((row) => [String(row._id), row.count]));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Terms fetched successfully.",
            message_desc: "Terms fetched successfully.",
            data: {
                current: versions[0]
                    ? { ...formatVersion(versions[0], acceptedBy.get(String(versions[0]._id)) || 0), content: versions[0].content }
                    : null,
                versions: versions.map((terms) => formatVersion(terms, acceptedBy.get(String(terms._id)) || 0)),
                parentsTotal,
                requiredVersion: required?.version || null,
            },
        });
    } catch (e) {
        return sendServerError(res, "List club terms", e);
    }
};

/**
 * GET /api/user/clubs/:id/terms/:version   (superAdmin, ya clubAdmin apne club ka)
 * Ek version poora text ke saath (purane versions sirf padhne ke liye).
 */
const getClubTermsVersion = async (req, res) => {
    try {
        const found = await findManagedClub(req);
        if (found.message) return sendError(res, found.status, found.message);

        const version = parseInt(req.params.version, 10);
        const terms = Number.isInteger(version)
            ? await ClubTerms.findOne({ clubId: found.club._id, version }).populate("createdBy", "firstname lastname")
            : null;
        if (!terms) return sendError(res, 404, "Terms version not found.");

        const acceptedCount = await TermsAcceptance.countDocuments({ termsId: terms._id });
        return res.status(200).json({
            error: false,
            status: 200,
            message: "Terms version fetched successfully.",
            message_desc: "Terms version fetched successfully.",
            data: { ...formatVersion(terms, acceptedCount), content: terms.content },
        });
    } catch (e) {
        return sendServerError(res, "Get terms version", e);
    }
};

/**
 * POST /api/user/clubs/:id/terms   (superAdmin, ya clubAdmin apne club ka)
 * body: { content: { ops: [...] }, requireReaccept? }   content = rich text editor (Quill Delta) ka document
 * Naya version banata hai. requireReaccept (default true) false ho toh parents ko dobara accept nahi karna
 * (jaise typo theek karna); pehla version hamesha accept karwata hai.
 */
const createClubTerms = async (req, res) => {
    try {
        const found = await findManagedClub(req);
        if (found.message) return sendError(res, found.status, found.message);
        const clubId = found.club._id;

        const checked = normalizeDelta(req.body.content);
        if (checked.error) return sendError(res, 400, checked.error);

        const latest = await ClubTerms.findOne({ clubId }).sort({ version: -1 });
        if (latest && JSON.stringify(latest.content) === JSON.stringify(checked.delta)) {
            return sendError(res, 400, "The terms have not changed.");
        }

        const reaccept = req.body.requireReaccept === undefined ? true : req.body.requireReaccept === true || req.body.requireReaccept === "true";

        const terms = await ClubTerms.create({
            clubId,
            version: (latest?.version || 0) + 1,
            content: checked.delta,
            plainText: checked.plainText,
            requireReaccept: latest ? reaccept : true,
            createdBy: req.user._id,
        });
        await terms.populate("createdBy", "firstname lastname");

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Terms saved as a new version.",
            message_desc: "Terms saved as a new version.",
            data: { ...formatVersion(terms, 0), content: terms.content },
        });
    } catch (e) {
        if (e.code === 11000) return sendError(res, 409, "The terms were just updated by someone else. Please reload and try again.");
        return sendServerError(res, "Create club terms", e);
    }
};

// Parent ka club (Parent model se). Parent na ho ya club na mile toh null
const parentClubId = async (req) => {
    if (req.user.role !== ROLES.PARENT) return null;
    const parent = await Parent.findOne({ userId: req.user._id }).select("clubId");
    return parent?.clubId || null;
};

/**
 * GET /api/user/terms/current   (parent)
 * Parent ke club ke current terms. mustAccept true ho toh app ko accept screen dikhani hai.
 * response: { terms: { version, content, createdAt } | null, mustAccept }
 */
const getCurrentTerms = async (req, res) => {
    try {
        if (req.user.role !== ROLES.PARENT) return sendError(res, 403, "Only parents can read the club terms here.");
        const clubId = await parentClubId(req);
        if (!clubId) return sendError(res, 404, "Your account is not linked to any club.");

        const [latest, required] = await Promise.all([
            ClubTerms.findOne({ clubId }).sort({ version: -1 }),
            getRequiredTerms(clubId),
        ]);
        const mustAccept = Boolean(required) && !(await hasAcceptedRequired(req.user._id, clubId, required));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Terms fetched successfully.",
            message_desc: "Terms fetched successfully.",
            data: {
                terms: latest ? { version: latest.version, content: latest.content, createdAt: latest.createdAt } : null,
                mustAccept,
            },
        });
    } catch (e) {
        return sendServerError(res, "Get current terms", e);
    }
};

const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";

/**
 * POST /api/user/terms/accept   (parent)
 * body: { version, device_type? }   version = abhi ka latest version (parent ne jo padha wahi)
 * Acceptance log mein time, IP aur device save hota hai. Dobara bhejne pe kuch nahi badalta.
 */
const acceptTerms = async (req, res) => {
    try {
        if (req.user.role !== ROLES.PARENT) return sendError(res, 403, "Only parents can accept the club terms.");
        const clubId = await parentClubId(req);
        if (!clubId) return sendError(res, 404, "Your account is not linked to any club.");

        const latest = await ClubTerms.findOne({ clubId }).sort({ version: -1 });
        if (!latest) return sendError(res, 404, "This club has no terms to accept.");

        const version = parseInt(req.body.version, 10);
        if (version !== latest.version) {
            return sendError(res, 409, "The terms were updated. Please read the latest version and accept again.", { latestVersion: latest.version });
        }

        const deviceType = ["android", "ios", "web"].includes(req.body.device_type) ? req.body.device_type : req.user.device_type || "";
        await TermsAcceptance.updateOne(
            { userId: req.user._id, termsId: latest._id },
            {
                $setOnInsert: {
                    clubId,
                    version: latest.version,
                    acceptedAt: new Date(),
                    ip: clientIp(req),
                    deviceType,
                    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
                },
            },
            { upsert: true }
        );

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Terms accepted.",
            message_desc: "Terms accepted.",
            data: { version: latest.version },
        });
    } catch (e) {
        return sendServerError(res, "Accept terms", e);
    }
};

module.exports = { listClubTerms, getClubTermsVersion, createClubTerms, getCurrentTerms, acceptTerms };
