const Note = require("../../models/Note");
const { NOTE_TYPES, NOTE_MAX_LENGTH } = require("../../models/Note");
const Coach = require("../../models/Coach");
const Player = require("../../models/Player");
const Team = require("../../models/Team");
const { ROLES } = require("../../helpers/constants");
const { isValidId, getPagination } = require("../../helpers/common");

// Coach notes + player notes (private). Rules:
//                 | coach note                  | player note
//   likhna        | manager                     | manager + us player ki team ka coach
//   dekhna        | manager + wahi coach        | manager + us player ki team ka coach
//   edit          | jisne likha                 | jisne likha
//   delete        | sirf manager                | sirf manager
// manager = superAdmin (sab clubs) ya clubAdmin (apna club). Parent / player kabhi nahi dekhte.

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

const isManager = (user) => [ROLES.SUPER_ADMIN, ROLES.CLUB_ADMIN].includes(user.role);

/**
 * Logged-in user kaun hai notes ke liye.
 *   manager: { manager: true, clubId (clubAdmin ka, superAdmin ka null) }
 *   coach:   { coach, clubId, teamIds }
 * Koi aur role: { status, message }
 */
const getViewer = async (req) => {
    if (req.user.role === ROLES.SUPER_ADMIN) return { manager: true, clubId: null };
    if (req.user.role === ROLES.CLUB_ADMIN) {
        if (!req.clubId) return { status: 403, message: "Your account is not linked to any club." };
        return { manager: true, clubId: req.clubId };
    }
    if (req.user.role === ROLES.COACH) {
        const coach = await Coach.findOne({ userId: req.user._id }).select("_id clubId");
        if (!coach) return { status: 404, message: "Coach profile not found." };
        const teams = await Team.find({ coachId: coach._id }).select("_id");
        return { manager: false, coach, clubId: coach.clubId, teamIds: teams.map((t) => String(t._id)) };
    }
    return { status: 403, message: "You don't have access to notes." };
};

// Manager ka club se match (superAdmin sab)
const managerCanSeeClub = (viewer, clubId) => viewer.clubId === null || String(viewer.clubId) === String(clubId);

// Coach is player ki team ka coach hai?
const coachHasPlayer = (viewer, player) => player.teamId && viewer.teamIds.includes(String(player.teamId));

/**
 * Ye user is note ko dekh sakta hai? note: populated nahi bhi chalega (coachId / playerId ids)
 * playerTeamId: player note ke liye player ki team (bahar se diya hua)
 */
const canView = (viewer, note, playerTeamId) => {
    if (viewer.manager) return managerCanSeeClub(viewer, note.clubId);
    if (String(note.clubId) !== String(viewer.clubId)) return false;
    if (note.type === "coach") return String(note.coachId?._id || note.coachId) === String(viewer.coach._id);
    return Boolean(playerTeamId) && viewer.teamIds.includes(String(playerTeamId));
};

const fullName = (u) => `${u?.firstname || ""} ${u?.lastname || ""}`.trim();

const populateNote = (query) =>
    query
        .populate({ path: "coachId", select: "userId", populate: { path: "userId", select: "firstname lastname profile_image" } })
        .populate({
            path: "playerId",
            select: "userId teamId",
            populate: [
                { path: "userId", select: "firstname lastname profile_image" },
                { path: "teamId", select: "name" },
            ],
        })
        .populate("createdBy", "firstname lastname profile_image role");

const formatNote = (note, req) => {
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
                team: player.teamId && player.teamId._id ? { _id: player.teamId._id, name: player.teamId.name } : null,
            }
            : null,
        createdBy: author
            ? { _id: author._id, name: fullName(author), profile_image: author.profile_image || "", role: note.createdByRole }
            : null,
        // Frontend buttons ke liye
        canEdit: String(author?._id || note.createdBy) === String(req.user._id),
        canDelete: isManager(req.user),
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

/**
 * POST /api/user/notes/create   (manager ya coach)
 * body: { type: "coach" | "player", coachId (type coach), playerId (type player), text }
 */
const createNote = async (req, res) => {
    try {
        const viewer = await getViewer(req);
        if (viewer.message) return sendError(res, viewer.status, viewer.message);

        const body = req.body || {};
        const type = String(body.type || "").trim().toLowerCase();
        if (!NOTE_TYPES.includes(type)) return sendError(res, 400, `Type must be one of: ${NOTE_TYPES.join(", ")}.`);

        const checked = cleanText(body.text);
        if (checked.message) return sendError(res, 400, checked.message);

        const data = { type, text: checked.text, createdBy: req.user._id, createdByRole: req.user.role };

        if (type === "coach") {
            // Coach note sirf manager likhta hai
            if (!viewer.manager) return sendError(res, 403, "Only managers can add coach notes.");
            const coachId = String(body.coachId || "").trim();
            if (!isValidId(coachId)) return sendError(res, 400, "Please select a valid coach.");
            const coach = await Coach.findById(coachId).select("clubId");
            if (!coach || !managerCanSeeClub(viewer, coach.clubId)) return sendError(res, 404, "Coach not found.");
            data.clubId = coach.clubId;
            data.coachId = coach._id;
        } else {
            const playerId = String(body.playerId || "").trim();
            if (!isValidId(playerId)) return sendError(res, 400, "Please select a valid player.");
            const player = await Player.findById(playerId).select("clubId teamId");
            if (!player) return sendError(res, 404, "Player not found.");
            if (viewer.manager) {
                if (!managerCanSeeClub(viewer, player.clubId)) return sendError(res, 404, "Player not found.");
            } else if (!coachHasPlayer(viewer, player)) {
                return sendError(res, 403, "You can only add notes for players in your teams.");
            }
            data.clubId = player.clubId;
            data.playerId = player._id;
        }

        const note = await Note.create(data);
        const saved = await populateNote(Note.findById(note._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Note added successfully.",
            message_desc: "Note added successfully.",
            data: formatNote(saved, req),
        });
    } catch (e) {
        return sendServerError(res, "Create note", e);
    }
};

/**
 * Notes ki list (andar ka function). type: "coach" ya "player", dono APIs isi ko use karti hain.
 *   manager: apne club ke notes (superAdmin saare, ya clubId se ek club)
 *   coach:   coach notes mein sirf apne baare ke, player notes mein sirf apni teams ke players ke
 */
const listNotesByType = async (req, res, type) => {
    try {
        const viewer = await getViewer(req);
        if (viewer.message) return sendError(res, viewer.status, viewer.message);

        const clubId = String(req.query.clubId || "").trim();
        const { page, limit, skip } = getPagination(req.query);

        const filter = { type };

        // Ek coach / ek player ke notes ("All coaches" dropdown)
        const targetKey = type === "coach" ? "coachId" : "playerId";
        const targetId = String(req.query[targetKey] || "").trim();
        if (targetId) {
            if (!isValidId(targetId)) return sendError(res, 400, `Invalid ${type} id.`);
            filter[targetKey] = targetId;
        }

        if (viewer.manager) {
            if (viewer.clubId) filter.clubId = viewer.clubId;
            else if (clubId) {
                if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
                filter.clubId = clubId;
            }
        } else {
            filter.clubId = viewer.clubId;
            if (type === "coach") {
                // Coach sirf apne baare ke notes. Kisi aur coach ki id di toh kuch nahi milega
                if (targetId && targetId !== String(viewer.coach._id)) filter.coachId = null;
                else filter.coachId = viewer.coach._id;
            } else {
                // Coach sirf apni teams ke players ke notes
                const myPlayers = viewer.teamIds.length
                    ? await Player.find({ teamId: { $in: viewer.teamIds } }).select("_id")
                    : [];
                const myPlayerIds = myPlayers.map((p) => String(p._id));
                filter.playerId = targetId
                    ? (myPlayerIds.includes(targetId) ? targetId : null)
                    : { $in: myPlayerIds };
            }
        }

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
                notes: notes.map((n) => formatNote(n, req)),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        return sendServerError(res, `List ${type} notes`, e);
    }
};

/**
 * GET /api/user/notes/coach?coachId=&clubId=&page=1&limit=20   (manager ya coach)
 * Coach notes. coachId = "All coaches" dropdown se ek coach.
 */
const listCoachNotes = (req, res) => listNotesByType(req, res, "coach");

/**
 * GET /api/user/notes/player?playerId=&clubId=&page=1&limit=20   (manager ya coach)
 * Player notes. playerId = ek player ke notes.
 */
const listPlayerNotes = (req, res) => listNotesByType(req, res, "player");

// Note id + dekhne ka haq. Galti ho toh { status, message }, warna { note, viewer }
const findNote = async (req, id) => {
    const viewer = await getViewer(req);
    if (viewer.message) return viewer;
    if (!isValidId(id)) return { status: 400, message: "Invalid note id." };

    const note = await Note.findById(id);
    if (!note) return { status: 404, message: "Note not found." };

    let playerTeamId = null;
    if (note.type === "player" && !viewer.manager) {
        const player = await Player.findById(note.playerId).select("teamId");
        playerTeamId = player?.teamId || null;
    }
    if (!canView(viewer, note, playerTeamId)) return { status: 404, message: "Note not found." };
    return { note, viewer };
};

/**
 * PUT /api/user/notes/:id/update   (sirf jisne note likha)
 * body: { text }
 */
const updateNote = async (req, res) => {
    try {
        const found = await findNote(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);
        const { note } = found;

        if (String(note.createdBy) !== String(req.user._id)) {
            return sendError(res, 403, "Only the person who wrote this note can edit it.");
        }

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
            data: formatNote(saved, req),
        });
    } catch (e) {
        return sendServerError(res, "Update note", e);
    }
};

/**
 * DELETE /api/user/notes/:id/delete   (sirf manager: superAdmin / clubAdmin)
 */
const deleteNote = async (req, res) => {
    try {
        if (!isManager(req.user)) return sendError(res, 403, "Only managers can delete notes.");

        const found = await findNote(req, req.params.id);
        if (found.message) return sendError(res, found.status, found.message);

        await Note.findByIdAndDelete(found.note._id);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Note deleted successfully.",
            message_desc: "Note deleted successfully.",
            data: { _id: found.note._id },
        });
    } catch (e) {
        return sendServerError(res, "Delete note", e);
    }
};

module.exports = { createNote, listCoachNotes, listPlayerNotes, updateNote, deleteNote, canView };