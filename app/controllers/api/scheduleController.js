const mongoose = require("mongoose");
const moment = require("moment");
const Schedule = require("../../models/Schedule");
const Team = require("../../models/Team");
const Coach = require("../../models/Coach");
const Facility = require("../../models/Facility");
const { SCHEDULE_TYPES, GAME_TYPES, REPEAT_FREQUENCIES, DATE_RX } = require("../../models/Schedule");
const { ROLES } = require("../../helpers/constants");
const { TIME_RX } = require("../../helpers/scheduleHelper");
const { isValidId } = require("../../helpers/common");

// Schedule (calendar). superAdmin sab clubs, clubAdmin sirf apna club, coach sirf apne published schedules.
// Repeat wala schedule EK hi document hai (date = pehli date, repeat.until = aakhri).
// List API range ki har date ke liye ek entry banati hai (us din ki "occurrence").
//   POST   /user/schedules/create
//   GET    /user/schedules                 calendar range + filters
//   GET    /user/schedules/:id             ?date= (repeat ki ek date)
//   PUT    /user/schedules/:id/update      scope = this | following | all, occurrenceDate
//   DELETE /user/schedules/:id/delete      ?scope=&occurrenceDate=
//   POST   /user/schedules/send            "Send schedule": drafts + badlav portal par

const SCOPES = ["this", "following", "all"];
const MAX_OCCURRENCES = 200; // ek repeat mein zyada se zyada itni dates
const MAX_REPEAT_DAYS = 366;
const MAX_RANGE_DAYS = 186; // list mein from-to ka max gap
const MAX_CONFLICTS_SHOWN = 50;
const REPEAT_STEP = { daily: 1, weekly: 7, biweekly: 14 };

// Document ke wo fields jo update / split mein copy hote hain
const FIELDS = [
    "type", "date", "startTime", "endTime", "teamId", "coachId", "facilityId", "opponent", "description",
    "status", "hasUnsentChanges", "publishedAt", "repeat", "excludedDates", "cancelledDates",
];

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

const sendOk = (res, status, message, data) =>
    res.status(status).json({ error: false, status, message, message_desc: message, data });

const isAdmin = (req) => [ROLES.SUPER_ADMIN, ROLES.CLUB_ADMIN].includes(req.user.role);

const canAccess = (req, clubId) =>
    req.user.role === ROLES.SUPER_ADMIN || String(req.clubId) === String(clubId?._id || clubId);

// ---------------------------------------------------------------------------
// Date / time helpers ("YYYY-MM-DD", "HH:MM")
// ---------------------------------------------------------------------------

// Asli date hai? (2026-02-30 nahi chalega)
const isValidDate = (d) => DATE_RX.test(d) && moment(d, "YYYY-MM-DD", true).isValid();
const addDays = (d, n) => moment(d, "YYYY-MM-DD").add(n, "days").format("YYYY-MM-DD");
const daysBetween = (a, b) => moment(b, "YYYY-MM-DD").diff(moment(a, "YYYY-MM-DD"), "days");

// Dono "HH:MM" zero-padded hain, isliye string compare = time compare
const overlaps = (a, b) => a.startTime < b.endTime && b.startTime < a.endTime;

// Kisi ek samay par zyada se zyada kitne intervals saath chal rahe hain
const maxConcurrent = (intervals) => {
    const points = [];
    intervals.forEach((i) => {
        points.push([i.startTime, 1]);
        points.push([i.endTime, -1]);
    });
    // Same time par pehle khatam (-1), phir shuru: 10:00 khatam + 10:00 shuru overlap nahi
    points.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    let current = 0;
    let max = 0;
    points.forEach(([, delta]) => {
        current += delta;
        max = Math.max(max, current);
    });
    return max;
};

// ---------------------------------------------------------------------------
// Repeat: document se dates
// ---------------------------------------------------------------------------

const isRecurring = (s) => Boolean(REPEAT_STEP[s.repeat?.frequency]);
const lastDate = (s) => (isRecurring(s) ? s.repeat.until : s.date);

// Schedule ki dates [from, to] ke beech (excludedDates chhod ke)
const occurrenceDates = (s, from, to) => {
    const skip = new Set(s.excludedDates || []);
    const step = REPEAT_STEP[s.repeat?.frequency];
    if (!step) return s.date >= from && s.date <= to && !skip.has(s.date) ? [s.date] : [];

    const end = s.repeat.until < to ? s.repeat.until : to;
    let d = s.date;
    if (d < from) d = addDays(d, Math.ceil(daysBetween(d, from) / step) * step);
    const dates = [];
    for (; d <= end; d = addDays(d, step)) if (!skip.has(d)) dates.push(d);
    return dates;
};

const allDates = (s) => occurrenceDates(s, s.date, lastDate(s));
const isOccurrence = (s, date) => occurrenceDates(s, date, date).length > 0;
const isCancelledOn = (s, date) => s.status === "cancelled" || (s.cancelledDates || []).includes(date);

// Mongo filter: jo schedules [from, to] mein kahin bhi padte hain
const rangeFilter = (from, to) => ({
    date: { $lte: to },
    $or: [{ date: { $gte: from } }, { "repeat.until": { $gte: from } }],
});

// ---------------------------------------------------------------------------
// Format / populate
// ---------------------------------------------------------------------------

const populateSchedule = (query) =>
    query
        .populate("clubId", "name")
        .populate({ path: "teamId", select: "name categoryId coachId", populate: { path: "categoryId", select: "name" } })
        .populate({ path: "coachId", select: "userId", populate: { path: "userId", select: "firstname lastname profile_image" } })
        .populate("facilityId", "name address type parallelUnits");

const populated = (ref) => (ref && typeof ref === "object" && ref._id ? ref : null);

// date = kis din ki entry (repeat mein har din alag). Na do toh pehli date.
const formatSchedule = (s, date = s.date) => {
    const team = populated(s.teamId);
    const coach = populated(s.coachId);
    const facility = populated(s.facilityId);
    const club = populated(s.clubId);
    return {
        _id: s._id,
        type: s.type,
        isGame: GAME_TYPES.includes(s.type),
        date,
        startTime: s.startTime,
        endTime: s.endTime,
        team: team
            ? { _id: team._id, name: team.name, category: populated(team.categoryId) ? { _id: team.categoryId._id, name: team.categoryId.name } : null }
            : null,
        coach: coach
            ? {
                _id: coach._id,
                firstname: coach.userId?.firstname || "",
                lastname: coach.userId?.lastname || "",
                profile_image: coach.userId?.profile_image || "",
            }
            : null,
        facility: facility ? { _id: facility._id, name: facility.name, address: facility.address || "", type: facility.type } : null,
        club: club ? { _id: club._id, name: club.name } : null,
        opponent: s.opponent || "",
        description: s.description || "",
        // Poora schedule cancel ho ya sirf yeh date
        status: isCancelledOn(s, date) ? "cancelled" : s.status,
        hasUnsentChanges: Boolean(s.hasUnsentChanges),
        publishedAt: s.publishedAt,
        isRecurring: isRecurring(s),
        startDate: s.date, // repeat ki pehli date
        repeat: { frequency: s.repeat?.frequency || "none", until: s.repeat?.until || "" },
        excludedDates: s.excludedDates || [],
        cancelledDates: s.cancelledDates || [],
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const optionalId = (raw) => {
    const id = raw === undefined || raw === null ? "" : String(raw).trim();
    return id || null;
};

/**
 * Body check. partial = update (sirf bheje gaye fields).
 * Time ka start < end check yahan nahi (update mein purane + naye mila ke hota hai).
 * Galti ho toh { message }, warna { values }
 */
const validateSchedule = (body, partial = false) => {
    body = body || {};
    const v = {};
    const has = (key) => body[key] !== undefined;

    if (!partial || has("type")) {
        v.type = String(body.type || "training").trim().toLowerCase();
        if (!SCHEDULE_TYPES.includes(v.type)) return { message: `Schedule type must be one of: ${SCHEDULE_TYPES.join(", ")}.` };
    }

    if (!partial || has("date")) {
        v.date = String(body.date ?? "").trim();
        if (!v.date) return { message: "Date is required." };
        if (!isValidDate(v.date)) return { message: "Date must be a valid date (YYYY-MM-DD)." };
    }

    for (const key of ["startTime", "endTime"]) {
        if (!partial || has(key)) {
            v[key] = String(body[key] ?? "").trim();
            const label = key === "startTime" ? "Start time" : "End time";
            if (!v[key]) return { message: `${label} is required.` };
            if (!TIME_RX.test(v[key])) return { message: `${label} must be in HH:MM format (00:00 - 23:59).` };
        }
    }

    if (!partial || has("teamId")) {
        v.teamId = optionalId(body.teamId);
        if (!v.teamId) return { message: "Team is required." };
        if (!isValidId(v.teamId)) return { message: "Invalid team id." };
    }

    // Coach / facility optional: "" ya null = hatao
    for (const [key, label] of [["coachId", "coach"], ["facilityId", "facility"]]) {
        if (!partial || has(key)) {
            v[key] = optionalId(body[key]);
            if (v[key] && !isValidId(v[key])) return { message: `Invalid ${label} id.` };
        }
    }

    if (!partial || has("opponent")) {
        v.opponent = String(body.opponent ?? "").trim();
        if (v.opponent.length > 150) return { message: "Opponent must be 150 characters or less." };
    }

    if (!partial || has("description")) {
        v.description = String(body.description ?? "").trim();
        if (v.description.length > 1000) return { message: "Description must be 1000 characters or less." };
    }

    // Sirf update: cancel / wapas active
    if (partial && has("status")) {
        const status = String(body.status).trim().toLowerCase();
        if (!["cancelled", "active"].includes(status)) return { message: 'Status must be "cancelled" or "active".' };
        v.status = status;
    }

    return { values: v };
};

const repeatSent = (body) =>
    body?.repeat !== undefined || body?.repeatFrequency !== undefined || body?.repeatUntil !== undefined;

/**
 * Repeat: { frequency: "weekly", until: "2026-12-31" } ya flat repeatFrequency / repeatUntil.
 * Galti ho toh { message }, warna { repeat }
 */
const parseRepeat = (body, startDate, excludedDates = []) => {
    const raw = typeof body.repeat === "object" && body.repeat !== null ? body.repeat : {};
    const frequency = String(raw.frequency ?? body.repeatFrequency ?? "none").trim().toLowerCase() || "none";
    if (!REPEAT_FREQUENCIES.includes(frequency)) {
        return { message: `Repeat must be one of: ${REPEAT_FREQUENCIES.join(", ")}.` };
    }
    if (frequency === "none") return { repeat: { frequency, until: "" } };

    const until = String(raw.until ?? body.repeatUntil ?? "").trim();
    if (!until) return { message: "Please choose an end date for the repeat." };
    if (!isValidDate(until)) return { message: "Repeat end date must be a valid date (YYYY-MM-DD)." };
    if (until < startDate) return { message: "Repeat end date must be on or after the schedule date." };
    if (daysBetween(startDate, until) > MAX_REPEAT_DAYS) return { message: "A repeat can run for at most one year." };

    const repeat = { frequency, until };
    if (allDates({ date: startDate, repeat, excludedDates }).length > MAX_OCCURRENCES) {
        return { message: `A repeat can have at most ${MAX_OCCURRENCES} dates.` };
    }
    return { repeat };
};

/**
 * Team, coach, facility ek hi club ke hain aur user ka access hai? Club team se aata hai.
 * Galti ho toh { status, message }, warna { clubId }
 */
const checkRefs = async (req, { teamId, coachId, facilityId }) => {
    const team = await Team.findById(teamId).select("clubId");
    if (!team || !canAccess(req, team.clubId)) return { status: 400, message: "Please select a valid team." };

    if (coachId && !(await Coach.exists({ _id: coachId, clubId: team.clubId }))) {
        return { status: 400, message: "Please select a valid coach from this club." };
    }
    if (facilityId && !(await Facility.exists({ _id: facilityId, clubId: team.clubId }))) {
        return { status: 400, message: "Please select a valid facility from this club." };
    }
    return { clubId: team.clubId };
};

// ---------------------------------------------------------------------------
// Conflicts: team / coach ek waqt par do jagah nahi, facility parallelUnits se zyada nahi
// ---------------------------------------------------------------------------

/**
 * candidates: naye / badle hue schedules (plain objects) jinki har date check hogi.
 * replacements: DB ke wo schedules jo save ke baad badal jayenge (DB wala version chhod ke yeh liya jaata hai).
 * Returns: [{ date, startTime, endTime, reason: "team" | "coach" | "facility", schedule: {...} }]
 */
const findConflicts = async (candidates, replacements = []) => {
    const plan = candidates
        .map((c) => ({ c, dates: allDates(c).filter((d) => !isCancelledOn(c, d)) }))
        .filter((p) => p.dates.length);
    if (!plan.length) return [];

    const dates = plan.flatMap((p) => p.dates).sort();
    const min = dates[0];
    const max = dates[dates.length - 1];
    const ids = (key) => [...new Set(candidates.map((c) => c[key]).filter(Boolean).map(String))];
    const facilityIds = ids("facilityId");

    const or = [{ teamId: { $in: ids("teamId") } }];
    if (ids("coachId").length) or.push({ coachId: { $in: ids("coachId") } });
    if (facilityIds.length) or.push({ facilityId: { $in: facilityIds } });

    const skipIds = [...candidates, ...replacements].filter((d) => d._id).map((d) => d._id);
    const [docs, facilities] = await Promise.all([
        Schedule.find({ _id: { $nin: skipIds }, status: { $ne: "cancelled" }, $and: [rangeFilter(min, max), { $or: or }] })
            .select("date startTime endTime teamId coachId facilityId type repeat excludedDates cancelledDates status")
            .populate("teamId", "name"),
        Facility.find({ _id: { $in: facilityIds } }).select("parallelUnits"),
    ]);
    const unitsOf = new Map(facilities.map((f) => [String(f._id), f.parallelUnits || 1]));

    // Har din ke chal rahe schedules
    const byDate = new Map();
    [...docs, ...replacements.filter((r) => r.status !== "cancelled")].forEach((s) => {
        occurrenceDates(s, min, max)
            .filter((d) => !isCancelledOn(s, d))
            .forEach((d) => byDate.set(d, [...(byDate.get(d) || []), s]));
    });

    const same = (a, b) => Boolean(a) && Boolean(b) && String(a?._id || a) === String(b?._id || b);
    const brief = (s, date) => ({
        _id: s._id,
        date,
        startTime: s.startTime,
        endTime: s.endTime,
        type: s.type,
        team: populated(s.teamId) ? { _id: s.teamId._id, name: s.teamId.name } : { _id: s.teamId },
    });

    const conflicts = [];
    plan.forEach(({ c, dates: cDates }) => {
        cDates.forEach((date) => {
            const clashing = (byDate.get(date) || []).filter((s) => overlaps(s, c));
            const add = (reason, s) =>
                conflicts.push({ date, startTime: c.startTime, endTime: c.endTime, reason, schedule: brief(s, date) });

            clashing.filter((s) => same(s.teamId, c.teamId)).forEach((s) => add("team", s));
            clashing.filter((s) => same(s.coachId, c.coachId)).forEach((s) => add("coach", s));

            if (c.facilityId) {
                const atFacility = clashing.filter((s) => same(s.facilityId, c.facilityId));
                // Sirf apne samay ke andar ka hissa gino
                const clipped = atFacility.map((s) => ({
                    startTime: s.startTime > c.startTime ? s.startTime : c.startTime,
                    endTime: s.endTime < c.endTime ? s.endTime : c.endTime,
                }));
                if (atFacility.length && maxConcurrent(clipped) >= (unitsOf.get(String(c.facilityId)) || 1)) {
                    atFacility.forEach((s) => add("facility", s));
                }
            }
        });
    });
    return conflicts;
};

const REASON_TEXT = { team: "The team", coach: "The coach", facility: "The facility" };

const sendConflicts = (res, conflicts) => {
    const first = conflicts[0];
    const message =
        `${REASON_TEXT[first.reason]} is already booked on ${first.date} ${first.schedule.startTime}-${first.schedule.endTime}` +
        (conflicts.length > 1 ? ` (and ${conflicts.length - 1} more conflict${conflicts.length > 2 ? "s" : ""}).` : ".") +
        " Send ignoreConflicts: true to save anyway.";
    return sendError(res, 409, message, { conflicts: conflicts.slice(0, MAX_CONFLICTS_SHOWN), total: conflicts.length });
};

const ignoreConflicts = (body) => body?.ignoreConflicts === true || String(body?.ignoreConflicts) === "true";

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// Coach ko sirf published schedules jahan wo coach hai ya uski team ka schedule hai
const coachFilter = async (req) => {
    const coach = await Coach.findOne({ userId: req.user._id }).select("_id clubId");
    if (!coach) return null;
    const teamIds = await Team.find({ coachId: coach._id }).distinct("_id");
    return {
        clubId: coach.clubId,
        publishedAt: { $ne: null },
        status: { $ne: "draft" },
        $or: [{ coachId: coach._id }, { teamId: { $in: teamIds } }],
    };
};

// Schedule id valid + access. Galti ho toh { status, message }
const findSchedule = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid schedule id." };
    const schedule = await Schedule.findById(id);
    if (!schedule || !canAccess(req, schedule.clubId)) return { status: 404, message: "Schedule not found." };
    return { schedule };
};

/**
 * Repeat wale schedule mein scope + occurrenceDate. Repeat nahi toh hamesha "all".
 * following + pehli date = all. Galti ho toh { message }, warna { scope, occ }
 */
const readScope = (req, schedule) => {
    let scope = String(req.body?.scope || req.query.scope || "this").trim().toLowerCase();
    if (!SCOPES.includes(scope)) return { message: `Scope must be one of: ${SCOPES.join(", ")}.` };
    if (!isRecurring(schedule)) return { scope: "all", occ: schedule.date };
    if (scope === "all") return { scope, occ: schedule.date };

    const occ = String(req.body?.occurrenceDate || req.query.occurrenceDate || "").trim();
    if (!occ) return { message: 'occurrenceDate is required when scope is "this" or "following".' };
    if (!isValidDate(occ) || !isOccurrence(schedule, occ)) return { message: "occurrenceDate is not a date of this schedule." };
    if (scope === "following" && occ === schedule.date) scope = "all";
    return { scope, occ };
};

// Status "active" = published tha toh published, warna draft
const statusFor = (base, requested) => (requested === "cancelled" ? "cancelled" : base.publishedAt ? "published" : "draft");

const pickFields = (o) => Object.fromEntries(FIELDS.map((k) => [k, o[k]]));

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/user/schedules/create   (superAdmin ya clubAdmin)
 * body: { type, date, startTime, endTime, teamId, coachId?, facilityId?, opponent?, description?,
 *         repeat?: { frequency: none|daily|weekly|biweekly, until }, ignoreConflicts? }
 * Repeat ho ya na ho, EK hi document banta hai. Naya schedule hamesha draft.
 */
const createSchedule = async (req, res) => {
    try {
        const body = req.body || {};

        const checked = validateSchedule(body);
        if (checked.message) return sendError(res, 400, checked.message);
        const values = checked.values;
        if (values.startTime >= values.endTime) return sendError(res, 400, "End time must be after start time.");
        if (!GAME_TYPES.includes(values.type)) values.opponent = "";

        const refs = await checkRefs(req, values);
        if (refs.message) return sendError(res, refs.status, refs.message);

        const rep = parseRepeat(body, values.date);
        if (rep.message) return sendError(res, 400, rep.message);

        const doc = { ...values, repeat: rep.repeat, clubId: refs.clubId, status: "draft", createdBy: req.user._id };

        if (!ignoreConflicts(body)) {
            const conflicts = await findConflicts([doc]);
            if (conflicts.length) return sendConflicts(res, conflicts);
        }

        const created = await Schedule.create(doc);
        const saved = await populateSchedule(Schedule.findById(created._id));
        const dates = allDates(saved);

        const message = dates.length > 1 ? `Schedule created as a draft (${dates.length} dates).` : "Schedule created as a draft.";
        return sendOk(res, 201, message, formatSchedule(saved));
    } catch (e) {
        return sendServerError(res, "Create schedule", e);
    }
};

/**
 * GET /api/user/schedules?from=2026-11-01&to=2026-11-07&type=training,game&games=home|away
 *                        &teamId=&coachId=&facilityId=&status=&clubId=(sirf superAdmin)
 * from / to na do toh is hafte (Sun-Sat). type: training | game | home_game | away_game | other, comma se kai.
 * Repeat wala schedule range ki har date par ek entry deta hai (same _id, alag date).
 * Pagination nahi: range ki saari entries, date + time order mein. Admin ko unsentCount bhi.
 */
const listSchedules = async (req, res) => {
    try {
        const q = req.query;
        const from = String(q.from || "").trim() || moment().startOf("week").format("YYYY-MM-DD");
        const to = String(q.to || "").trim() || addDays(from, 6);
        if (!isValidDate(from) || !isValidDate(to)) return sendError(res, 400, "from / to must be valid dates (YYYY-MM-DD).");
        if (to < from) return sendError(res, 400, '"to" must be on or after "from".');
        if (daysBetween(from, to) > MAX_RANGE_DAYS) return sendError(res, 400, `Date range can be at most ${MAX_RANGE_DAYS} days.`);

        const and = [rangeFilter(from, to)];
        let clubId = null;

        if (req.user.role === ROLES.COACH) {
            const own = await coachFilter(req);
            if (!own) return sendError(res, 403, "Your account is not linked to any club.");
            and.push(own);
        } else if (isAdmin(req)) {
            if (req.user.role === ROLES.CLUB_ADMIN) {
                if (!req.clubId) return sendError(res, 403, "Your account is not linked to any club.");
                clubId = req.clubId;
            } else if (q.clubId) {
                if (!isValidId(q.clubId)) return sendError(res, 400, "Invalid club id.");
                clubId = q.clubId;
            }
            if (clubId) and.push({ clubId });
        } else {
            return sendError(res, 403, "Access denied.");
        }

        // Type: "game" = home + away
        let types = null;
        if (q.type) {
            types = new Set();
            for (const t of String(q.type).toLowerCase().split(",").map((x) => x.trim()).filter(Boolean)) {
                if (t === "game") GAME_TYPES.forEach((g) => types.add(g));
                else if (SCHEDULE_TYPES.includes(t)) types.add(t);
                else return sendError(res, 400, `Invalid type "${t}".`);
            }
        }

        // Games dropdown: sirf home / sirf away (trainings bhi chhupa deta hai)
        if (q.games) {
            const games = String(q.games).trim().toLowerCase();
            if (games === "home" || games === "away") {
                const only = `${games}_game`;
                types = new Set(!types || types.has(only) ? [only] : []);
            } else if (games !== "all") {
                return sendError(res, 400, 'games must be "all", "home" or "away".');
            }
        }
        if (types) and.push({ type: { $in: [...types] } });

        for (const key of ["teamId", "coachId", "facilityId"]) {
            if (q[key]) {
                if (!isValidId(q[key])) return sendError(res, 400, `Invalid ${key}.`);
                and.push({ [key]: q[key] });
            }
        }

        // Status har date ka alag ho sakta hai (cancelledDates), isliye entries banne ke baad filter
        const statuses = q.status && isAdmin(req) ? String(q.status).toLowerCase().split(",").map((x) => x.trim()) : null;

        const docs = await populateSchedule(Schedule.find({ $and: and }));
        const schedules = docs
            .flatMap((s) => occurrenceDates(s, from, to).map((d) => formatSchedule(s, d)))
            .filter((row) => !statuses || statuses.includes(row.status))
            .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));

        const data = { from, to, schedules };
        if (isAdmin(req)) {
            const unsentFilter = { $or: [{ status: "draft" }, { hasUnsentChanges: true }] };
            if (clubId) unsentFilter.clubId = clubId;
            data.unsentCount = await Schedule.countDocuments(unsentFilter);
        }

        return sendOk(res, 200, "Schedules fetched successfully.", data);
    } catch (e) {
        return sendServerError(res, "List schedules", e);
    }
};

/**
 * GET /api/user/schedules/:id?date=2026-11-09   (admin; coach sirf apna published schedule)
 * date = repeat ki kaunsi date (na do toh pehli).
 */
const getSchedule = async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidId(id)) return sendError(res, 400, "Invalid schedule id.");

        let filter = { _id: id };
        if (req.user.role === ROLES.COACH) {
            const own = await coachFilter(req);
            if (!own) return sendError(res, 404, "Schedule not found.");
            filter = { $and: [filter, own] };
        } else if (!isAdmin(req)) {
            return sendError(res, 403, "Access denied.");
        }

        const schedule = await populateSchedule(Schedule.findOne(filter));
        if (!schedule || !canAccess(req, schedule.clubId)) return sendError(res, 404, "Schedule not found.");

        const date = String(req.query.date || "").trim() || schedule.date;
        if (!isValidDate(date) || !isOccurrence(schedule, date)) return sendError(res, 404, "This date is not part of the schedule.");

        return sendOk(res, 200, "Schedule fetched successfully.", formatSchedule(schedule, date));
    } catch (e) {
        return sendServerError(res, "Get schedule", e);
    }
};

/**
 * PUT /api/user/schedules/:id/update   (superAdmin ya clubAdmin)
 * body: jo badalna hai wahi + ignoreConflicts?
 *       status: "cancelled" = cancel, "active" = wapas
 *       repeat: { frequency, until } (scope all / following)
 * Repeat wale schedule par:
 *   scope "all"                        -> yahi document badalta hai
 *   scope "this" + occurrenceDate      -> sirf status: cancelledDates mein jodna / hatana
 *                                         baaki badlav: wo date is schedule se hat ke alag (bina repeat) schedule banti hai
 *   scope "following" + occurrenceDate -> yeh schedule us date se pehle khatam, aage ki dates naya repeat schedule
 * Published schedule badle toh hasUnsentChanges = true, "Send schedule" tak.
 */
const updateSchedule = async (req, res) => {
    try {
        const body = req.body || {};
        const found = await findSchedule(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const doc = found.schedule;
        const base = doc.toObject();

        const sc = readScope(req, base);
        if (sc.message) return sendError(res, 400, sc.message);
        const { scope, occ } = sc;

        const checked = validateSchedule(body, true);
        if (checked.message) return sendError(res, 400, checked.message);
        const { status, ...fields } = checked.values;
        const changingRepeat = repeatSent(body);
        if (!Object.keys(checked.values).length && !changingRepeat) return sendError(res, 400, "Nothing to update.");

        if (scope === "this" && changingRepeat) return sendError(res, 400, 'Repeat can only be changed with scope "all" or "following".');
        if (scope === "following" && fields.date) {
            return sendError(res, 400, 'Date cannot be changed for following dates. Use scope "all" or "this".');
        }

        const unsent = Boolean(base.publishedAt); // published tha toh portal ko batana baaki
        let next; // jo document save hoga (existing ya naya)
        let parentNext = null; // split mein purana document ka naya roop
        let parentGone = false;

        // Poora schedule cancel ho aur sirf ek date wapas chahiye: wo date split hogi (neeche)
        const onlyDateStatus = scope === "this" && Object.keys(fields).length === 0 && !(status === "active" && base.status === "cancelled");

        if (onlyDateStatus) {
            // Sirf ek date cancel / wapas: document mein hi
            const cancelled = new Set(base.cancelledDates || []);
            if (status === "cancelled") cancelled.add(occ);
            else cancelled.delete(occ);
            next = { ...base, cancelledDates: [...cancelled].sort(), hasUnsentChanges: base.hasUnsentChanges || unsent };
        } else if (scope === "all") {
            next = { ...base, ...fields, hasUnsentChanges: base.hasUnsentChanges || unsent };
            if (status) next.status = statusFor(base, status);
        } else {
            // Split: yeh date (this) ya yahan se aage (following) naya document
            const following = scope === "following";
            next = {
                ...base,
                _id: new mongoose.Types.ObjectId(),
                date: occ,
                repeat: following ? base.repeat : { frequency: "none", until: "" },
                excludedDates: following ? (base.excludedDates || []).filter((d) => d >= occ) : [],
                cancelledDates: following ? (base.cancelledDates || []).filter((d) => d >= occ) : [],
                ...fields,
                status: status ? statusFor(base, status) : !following && isCancelledOn(base, occ) ? "cancelled" : base.status,
                hasUnsentChanges: unsent,
                isNew: true,
            };
            parentNext = following
                ? {
                    ...base,
                    repeat: { ...base.repeat, until: addDays(occ, -1) },
                    excludedDates: (base.excludedDates || []).filter((d) => d < occ),
                    cancelledDates: (base.cancelledDates || []).filter((d) => d < occ),
                }
                : {
                    ...base,
                    excludedDates: [...new Set([...(base.excludedDates || []), occ])].sort(),
                    cancelledDates: (base.cancelledDates || []).filter((d) => d !== occ),
                };
            parentNext.hasUnsentChanges = base.hasUnsentChanges || unsent;
            parentGone = allDates(parentNext).length === 0;
        }

        if (!GAME_TYPES.includes(next.type)) next.opponent = "";
        if (next.startTime >= next.endTime) return sendError(res, 400, "End time must be after start time.");

        // Repeat: naya bheja ho ya date badli ho, dono mein check
        const rep = parseRepeat(changingRepeat ? body : { repeat: next.repeat }, next.date, next.excludedDates);
        if (rep.message) return sendError(res, 400, rep.message);
        next.repeat = rep.repeat;
        if (!isRecurring(next)) next.excludedDates = next.cancelledDates = [];
        if (!allDates(next).length) return sendError(res, 400, "This change leaves the schedule without any date.");

        if (["teamId", "coachId", "facilityId"].some((k) => fields[k] !== undefined)) {
            const refs = await checkRefs(req, next);
            if (refs.message) return sendError(res, refs.status, refs.message);
            if (String(refs.clubId) !== String(base.clubId)) {
                return sendError(res, 400, "A schedule cannot be moved to a team from another club.");
            }
        }

        // Clash sirf tab check jab din / time / team / coach / facility / repeat badle ya kuch wapas active hua
        const timingChanged =
            ["date", "startTime", "endTime", "teamId", "coachId", "facilityId"].some((k) => fields[k] !== undefined) ||
            changingRepeat ||
            status === "active";

        if (timingChanged && !ignoreConflicts(body)) {
            const conflicts = await findConflicts([next], parentNext && !parentGone ? [parentNext] : []);
            if (conflicts.length) return sendConflicts(res, conflicts);
        }

        const savedIds = [];
        if (next.isNew) {
            const created = await Schedule.create({ ...pickFields(next), _id: next._id, clubId: base.clubId, createdBy: req.user._id });
            savedIds.push(created._id);
            if (parentGone) {
                await Schedule.deleteOne({ _id: doc._id });
            } else {
                doc.set(pickFields(parentNext));
                await doc.save();
                savedIds.unshift(doc._id);
            }
        } else {
            doc.set(pickFields(next));
            await doc.save();
            savedIds.push(doc._id);
        }

        const saved = await populateSchedule(Schedule.find({ _id: { $in: savedIds } }).sort({ date: 1 }));
        return sendOk(res, 200, "Schedule updated successfully.", {
            schedules: saved.map((s) => formatSchedule(s)),
            deletedId: parentGone ? doc._id : null,
        });
    } catch (e) {
        return sendServerError(res, "Update schedule", e);
    }
};

/**
 * DELETE /api/user/schedules/:id/delete?scope=this|following|all&occurrenceDate=2026-11-16
 * Repeat wale schedule par:
 *   all       -> poora document delete
 *   this      -> sirf wo date (excludedDates mein)
 *   following -> wo date aur aage ki (repeat us date se pehle khatam)
 * Koi date na bache toh document delete. Sirf "nahi hoga" dikhana ho toh update mein status: "cancelled".
 */
const deleteSchedule = async (req, res) => {
    try {
        const found = await findSchedule(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const doc = found.schedule;

        const sc = readScope(req, doc);
        if (sc.message) return sendError(res, 400, sc.message);
        const { scope, occ } = sc;

        if (scope !== "all") {
            if (scope === "this") {
                doc.excludedDates = [...new Set([...(doc.excludedDates || []), occ])].sort();
                doc.cancelledDates = (doc.cancelledDates || []).filter((d) => d !== occ);
            } else {
                doc.repeat.until = addDays(occ, -1);
                doc.excludedDates = (doc.excludedDates || []).filter((d) => d < occ);
                doc.cancelledDates = (doc.cancelledDates || []).filter((d) => d < occ);
            }

            if (allDates(doc).length) {
                if (doc.publishedAt) doc.hasUnsentChanges = true;
                await doc.save();
                const saved = await populateSchedule(Schedule.findById(doc._id));
                return sendOk(res, 200, scope === "this" ? "Date removed from the schedule." : "Following dates removed from the schedule.", {
                    deleted: false,
                    schedule: formatSchedule(saved),
                });
            }
        }

        await Schedule.deleteOne({ _id: doc._id });
        return sendOk(res, 200, "Schedule deleted successfully.", { deleted: true, _id: doc._id });
    } catch (e) {
        return sendServerError(res, "Delete schedule", e);
    }
};

/**
 * POST /api/user/schedules/send   (superAdmin ya clubAdmin) - "Send schedule" button
 * body: { clubId (sirf superAdmin, required) }
 * Saare drafts published, aur published schedules ke badlav bhi portal par.
 * NOTE: push notification abhi nahi (draft banner: "with no push notification").
 */
const sendSchedule = async (req, res) => {
    try {
        const clubId = req.user.role === ROLES.CLUB_ADMIN ? req.clubId : String(req.body?.clubId || "").trim();
        if (!clubId || !isValidId(String(clubId))) return sendError(res, 400, "Please select a valid club.");

        const now = new Date();
        const [drafts, changed] = await Promise.all([
            Schedule.updateMany({ clubId, status: "draft" }, { $set: { status: "published", publishedAt: now, hasUnsentChanges: false } }),
            Schedule.updateMany({ clubId, hasUnsentChanges: true }, { $set: { hasUnsentChanges: false } }),
        ]);

        const sent = drafts.modifiedCount + changed.modifiedCount;
        const message = sent ? `Schedule sent: ${sent} schedule${sent > 1 ? "s" : ""} updated on the portals.` : "Nothing new to send.";
        return sendOk(res, 200, message, { published: drafts.modifiedCount, updated: changed.modifiedCount, sentAt: now });
    } catch (e) {
        return sendServerError(res, "Send schedule", e);
    }
};

module.exports = {
    createSchedule,
    listSchedules,
    getSchedule,
    updateSchedule,
    deleteSchedule,
    sendSchedule,
};
