const Note = require("../../models/Note");
const { NOTE_TYPES, NOTE_MAX_LENGTH } = require("../../models/Note");
const Coach = require("../../models/Coach");
const Player = require("../../models/Player");
const Parent = require("../../models/Parent");
const Team = require("../../models/Team");
const { ROLES } = require("../../helpers/constants");
const { isValidId, getPagination } = require("../../helpers/common");

// Notes: neeche wale likhte hain, upar wale padhte hain.
//
//               | COACH NOTE                          | PLAYER NOTE
//   likhna      | coach (apne naam se)                | parent (apne youth bachche ke liye),
//               |                                     | senior player (apne liye)
//   padhna      | club admin, superAdmin              | us player ki team ka coach, club admin, superAdmin
//               | + likhne wala coach                 | + parent (apne bachchon ke) / senior (apne)
//   edit        | sirf likhne wala                    | sirf likhne wala
//   delete      | likhne wala, ya club admin / superAdmin (dono type)
//
// clubAdmin sirf apne club ke notes, superAdmin sab clubs ke.

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

const isManagerRole = (role) => [ROLES.SUPER_ADMIN, ROLES.CLUB_ADMIN].includes(role);
const sameId = (a, b) => Boolean(a) && Boolean(b) && String(a?._id || a) === String(b?._id || b);

// ---------------------------------------------------------------------------
// Logged-in user notes ke liye kaun hai
// ---------------------------------------------------------------------------

/**
 * kind: "manager" | "coach" | "parent" | "senior"
 *   manager: { clubId (superAdmin ka null) }
 *   coach:   { coach, clubId, teamIds[] }
 *   parent:  { parent, clubId, childPlayerIds[] }
 *   senior:  { player, clubId }
 * Koi aur (youth player ka login nahi hota): { status, message }
 */
const getViewer = async (req) => {
    const { role, _id } = req.user;
    const userId = _id;

    if (role === ROLES.SUPER_ADMIN) return { kind: "manager", userId, clubId: null };

    if (role === ROLES.CLUB_ADMIN) {
        if (!req.clubId) return { status: 403, message: "Your account is not linked to any club." };
        return { kind: "manager", userId, clubId: req.clubId };
    }

    if (role === ROLES.COACH) {
        const coach = await Coach.findOne({ userId }).select("_id clubId");
        if (!coach) return { status: 404, message: "Coach profile not found." };
        const teams = await Team.find({ coachId: coach._id }).select("_id");
        return { kind: "coach", userId, coach, clubId: coach.clubId, teamIds: teams.map((t) => String(t._id)) };
    }

    if (role === ROLES.PARENT) {
        const parent = await Parent.findOne({ userId }).select("_id clubId");
        if (!parent) return { status: 403, message: "Please select your club first." };
        const children = await Player.find({ "parents.parentId": parent._id }).select("_id");
        return { kind: "parent", userId, parent, clubId: parent.clubId, childPlayerIds: children.map((p) => String(p._id)) };
    }

    if (role === ROLES.SENIOR_PLAYER) {
        const player = await Player.findOne({ userId }).select("_id clubId teamId");
        if (!player) return { status: 404, message: "Player profile not found." };
        return { kind: "senior", userId, player, clubId: player.clubId };
    }

    return { status: 403, message: "You don't have access to notes." };
};

// Manager ka club (superAdmin sab)
const managerSeesClub = (viewer, clubId) => viewer.clubId === null || sameId(viewer.clubId, clubId);

/**
 * Ye user is note ko dekh sakta hai?
 * playerTeamId: player note ke liye us player ki team (coach check ke liye)
 */
const canView = (viewer, note, playerTeamId = null) => {
    // Likhne wala apna note hamesha dekh sakta hai
    if (sameId(note.createdBy, viewer.userId)) return true;

    if (viewer.kind === "manager") return managerSeesClub(viewer, note.clubId);
    if (!sameId(note.clubId, viewer.clubId)) return false;

    if (note.type === "coach") return false; // coach note sirf likhne wala + manager

    // Player note
    if (viewer.kind === "coach") return Boolean(playerTeamId) && viewer.teamIds.includes(String(playerTeamId));
    if (viewer.kind === "parent") return viewer.childPlayerIds.includes(String(note.playerId?._id || note.playerId));
    if (viewer.kind === "senior") return sameId(note.playerId, viewer.player._id);
    return false;
};

const canEditNote = (viewer, note) => sameId(note.createdBy, viewer.userId);

const canDeleteNote = (viewer, note) =>
    sameId(note.createdBy, viewer.userId) || (viewer.kind === "manager" && managerSeesClub(viewer, note.clubId));

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

const fullName = (u) => `${u?.firstname || ""} ${u?.lastname || ""}`.trim();

const populateNote = (query) =>
    query
        .populate({ path: "coachId", select: "userId", populate: { path: "userId", select: "firstname lastname profile_image" } })
        .populate({
            path: "playerId",
            select: "userId teamId playerType",
            populate: [
                { path: "userId", select: "firstname lastname profile_image" },
                { path: "teamId", select: "name" },
            ],
        })
        .populate("createdBy", "firstname lastname profile_image");

const formatNote = (note, viewer) => {
    const coach = note.coachId && note.coachId._id ? note.coachId : null;
    const player = note.playerId && note.playerId._id ? note.playerId : null;
    const author = note.createdBy && note.createdBy._id ? note.createdBy : null;
    return {
        _id: note._id,
        type: note.type,
        text: note.text,
        coach: coach
            ? { _id: coach._id, name: fullName(coach.userId), profile_image: coach.userId?.profile_image || "" }
            : null,
        player: player
            ? {
                _id: player._id,
                name: fullName(player.userId),
                profile_image: player.userId?.profile_image || "",
                playerType: player.playerType,
                team: player.teamId && player.teamId._id ? { _id: player.teamId._id, name: player.teamId.name } : null,
            }
            : null,
        // Kisne likha: coach / parent / seniorPlayer
        createdBy: author
            ? { _id: author._id, name: fullName(author), profile_image: author.profile_image || "", role: note.createdByRole }
            : null,
        // Frontend ke Edit / Delete buttons ke liye
        canEdit: canEditNote(viewer, note),
        canDelete: canDeleteNote(viewer, note),
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    };
};

// Note ka text check
const cleanText = (raw) => {
    const text = String(raw ?? "").trim();
    if (!text) return { message: "Note text is required." };
    if (text.length > NOTE_MAX_LENGTH) return { message: `Note must be ${NOTE_MAX_LENGTH} characters or less.` };
    return { text };
};

// List ka response (dono list APIs ka same shape)
const sendNotesPage = async (req, res, viewer, filter) => {
    const { page, limit, skip } = getPagination(req.query);
    const [notes, total] = await Promise.all([
        populateNote(Note.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)),
        Note.countDocuments(filter),
    ]);
    return res.status(200).json({
        error: false,
        status: 200,
        message: "Notes fetched successfully.",
        message_desc: "Notes fetched successfully.",
        data: {
            notes: notes.map((n) => formatNote(n, viewer)),
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        },
    });
};

// ---------------------------------------------------------------------------
// APIs
// ---------------------------------------------------------------------------

/**
 * POST /api/user/notes/create
 *   Coach:          { text }                     -> coach note (apne naam se)
 *   Parent:         { playerId, text }           -> player note (apne youth bachche ke liye)
 *   Senior player:  { text }                     -> player note (apne liye)
 * "type" bhejna optional hai (role se apne aap tay hota hai). Bheja aur role se match nahi kiya toh error.
 * Club admin / superAdmin notes nahi likhte, sirf padhte hain.
 */
const createNote = async (req, res) => {
    try {
        const viewer = await getViewer(req);
        if (viewer.message) return sendError(res, viewer.status, viewer.message);

        if (viewer.kind === "manager") return sendError(res, 403, "Managers can view notes but can't add them.");

        const body = req.body || {};
        const expectedType = viewer.kind === "coach" ? "coach" : "player";
        const type = body.type ? String(body.type).trim().toLowerCase() : expectedType;
        if (!NOTE_TYPES.includes(type)) return sendError(res, 400, `Type must be one of: ${NOTE_TYPES.join(", ")}.`);
        if (type !== expectedType) {
            return sendError(
                res,
                403,
                expectedType === "coach"
                    ? "Coaches can only add coach notes."
                    : "Parents and senior players can only add player notes."
            );
        }

        const checked = cleanText(body.text);
        if (checked.message) return sendError(res, 400, checked.message);

        const data = {
            type,
            text: checked.text,
            clubId: viewer.clubId,
            createdBy: req.user._id,
            createdByRole: req.user.role,
        };

        if (viewer.kind === "coach") {
            data.coachId = viewer.coach._id;
        } else if (viewer.kind === "senior") {
            data.playerId = viewer.player._id;
        } else {
            // Parent: kis bachche ke liye
            const playerId = String(body.playerId || "").trim();
            if (!isValidId(playerId)) return sendError(res, 400, "Please select a valid player.");
            if (!viewer.childPlayerIds.includes(playerId)) {
                return sendError(res, 403, "You can only add notes for your own children.");
            }
            const player = await Player.findById(playerId).select("clubId");
            if (!player) return sendError(res, 404, "Player not found.");
            data.playerId = player._id;
            data.clubId = player.clubId;
        }

        const note = await Note.create(data);
        const saved = await populateNote(Note.findById(note._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Note added successfully.",
            message_desc: "Note added successfully.",
            data: formatNote(saved, viewer),
        });
    } catch (e) {
        return sendServerError(res, "Create note", e);
    }
};

/**
 * GET /api/user/notes/coach?coachId=&clubId=&page=1&limit=20
 *   club admin / superAdmin: club ke saare coach notes (coachId = "All coaches" dropdown, clubId sirf superAdmin)
 *   coach:                   sirf apne likhe hue
 *   baaki:                   403
 */
const listCoachNotes = async (req, res) => {
    try {
        const viewer = await getViewer(req);
        if (viewer.message) return sendError(res, viewer.status, viewer.message);

        const coachId = String(req.query.coachId || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        if (coachId && !isValidId(coachId)) return sendError(res, 400, "Invalid coach id.");

        const filter = { type: "coach" };

        if (viewer.kind === "manager") {
            if (coachId) filter.coachId = coachId;
            if (viewer.clubId) filter.clubId = viewer.clubId;
            else if (clubId) {
                if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
                filter.clubId = clubId;
            }
        } else if (viewer.kind === "coach") {
            filter.coachId = viewer.coach._id;
            filter.createdBy = viewer.userId;
        } else {
            return sendError(res, 403, "You don't have access to coach notes.");
        }

        return await sendNotesPage(req, res, viewer, filter);
    } catch (e) {
        return sendServerError(res, "List coach notes", e);
    }
};

/**
 * GET /api/user/notes/player?playerId=&clubId=&page=1&limit=20
 *   club admin / superAdmin: club ke saare player notes (clubId sirf superAdmin)
 *   coach:                   apni teams ke players ke
 *   parent:                  apne bachchon ke
 *   senior player:           apne
 * playerId = ek player ke notes (sirf wahi jo upar ke hisaab se allowed hai)
 */
const listPlayerNotes = async (req, res) => {
    try {
        const viewer = await getViewer(req);
        if (viewer.message) return sendError(res, viewer.status, viewer.message);

        const playerId = String(req.query.playerId || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        if (playerId && !isValidId(playerId)) return sendError(res, 400, "Invalid player id.");

        const filter = { type: "player" };

        // Ye user kin players ke notes dekh sakta hai (manager ke liye null = club ke sab)
        let allowedPlayerIds = null;

        if (viewer.kind === "manager") {
            if (viewer.clubId) filter.clubId = viewer.clubId;
            else if (clubId) {
                if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
                filter.clubId = clubId;
            }
        } else {
            filter.clubId = viewer.clubId;
            if (viewer.kind === "coach") {
                const teamPlayers = viewer.teamIds.length
                    ? await Player.find({ teamId: { $in: viewer.teamIds } }).select("_id")
                    : [];
                allowedPlayerIds = teamPlayers.map((p) => String(p._id));
            } else if (viewer.kind === "parent") {
                allowedPlayerIds = viewer.childPlayerIds;
            } else {
                allowedPlayerIds = [String(viewer.player._id)];
            }
        }

        if (allowedPlayerIds === null) {
            if (playerId) filter.playerId = playerId;
        } else if (playerId) {
            // Allowed nahi toh khaali list (doosre ke notes kabhi nahi)
            filter.playerId = allowedPlayerIds.includes(playerId) ? playerId : null;
        } else {
            filter.playerId = { $in: allowedPlayerIds };
        }

        return await sendNotesPage(req, res, viewer, filter);
    } catch (e) {
        return sendServerError(res, "List player notes", e);
    }
};

// Note id + dekhne ka haq. Galti ho toh { status, message }, warna { note, viewer }
const findNote = async (req, id) => {
    const viewer = await getViewer(req);
    if (viewer.message) return viewer;
    if (!isValidId(id)) return { status: 400, message: "Invalid note id." };

    const note = await Note.findById(id);
    if (!note) return { status: 404, message: "Note not found." };

    let playerTeamId = null;
    if (note.type === "player" && viewer.kind === "coach") {
        const player = await Player.findById(note.playerId).select("teamId");
        playerTeamId = player?.teamId || null;
    }
    if (!canView(viewer, note, playerTeamId)) return { status: 404, message: "Note not found." };
    return { note, viewer };
};

/**
 * GET /api/user/notes/:id   (jo note dekh sakta hai)
 */
const getNote = async (req, res) => {
    try {
        const found = await findNote(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);

        const saved = await populateNote(Note.findById(found.note._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Note fetched successfully.",
            message_desc: "Note fetched successfully.",
            data: formatNote(saved, found.viewer),
        });
    } catch (e) {
        return sendServerError(res, "Get note", e);
    }
};

/**
 * PUT /api/user/notes/:id/update   (sirf jisne note likha)
 * body: { text }
 */
const updateNote = async (req, res) => {
    try {
        const found = await findNote(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { note, viewer } = found;

        if (!canEditNote(viewer, note)) return sendError(res, 403, "Only the person who wrote this note can edit it.");

        const checked = cleanText((req.body || {}).text);
        if (checked.message) return sendError(res, 400, checked.message);

        note.text = checked.text;
        await note.save();
        const saved = await populateNote(Note.findById(note._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Note updated successfully.",
            message_desc: "Note updated successfully.",
            data: formatNote(saved, viewer),
        });
    } catch (e) {
        return sendServerError(res, "Update note", e);
    }
};

/**
 * DELETE /api/user/notes/:id/delete   (likhne wala, ya club admin / superAdmin)
 */
const deleteNote = async (req, res) => {
    try {
        const found = await findNote(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { note, viewer } = found;

        if (!canDeleteNote(viewer, note)) {
            return sendError(res, 403, "Only the person who wrote this note or a club admin can delete it.");
        }

        await Note.findByIdAndDelete(note._id);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Note deleted successfully.",
            message_desc: "Note deleted successfully.",
            data: { _id: note._id },
        });
    } catch (e) {
        return sendServerError(res, "Delete note", e);
    }
};

module.exports = {
    createNote,
    listCoachNotes,
    listPlayerNotes,
    getNote,
    updateNote,
    deleteNote,
    // test ke liye
    canView,
    canEditNote,
    canDeleteNote,
};