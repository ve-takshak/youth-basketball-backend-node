const Note = require("../../models/Note");
const { NOTE_TYPES, NOTE_MAX_LENGTH } = require("../../models/Note");
const Coach = require("../../models/Coach");
const Player = require("../../models/Player");
const Team = require("../../models/Team");
const Parent = require("../../models/Parent");
const { ROLES } = require("../../helpers/constants");
const { isValidId, getPagination } = require("../../helpers/common");

// Coach notes + player notes. Rules:
//                 | coach note                  | player note
//   likhna        | manager                     | manager + us player ki team ka coach
//   dekhna        | manager + wahi coach        | abhi tay nahi: koi bhi logged-in user, sirf apne club ke
//                 |                             | (frontend jahan chahe dikhaye)
//   edit          | jisne likha                 | jisne likha
//   delete        | sirf manager                | sirf manager
// manager = superAdmin (sab clubs) ya clubAdmin (apna club).

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
 * Ye coach / manager is note ko dekh sakta hai? (update / delete ke liye)
 * Player note: abhi koi team rule nahi, sirf same club.
 */
const canView = (viewer, note) => {
    if (viewer.manager) return managerCanSeeClub(viewer, note.clubId);
    if (String(note.clubId) !== String(viewer.clubId)) return false;
    if (note.type === "coach") return String(note.coachId?._id || note.coachId) === String(viewer.coach._id);
    return true;
};

/**
 * Player notes ki list ke liye: user kis club ka hai (koi bhi role).
 * superAdmin: null (sab clubs). Club na mile toh { status, message }
 */
const getUserClubId = async (req) => {
    const { role, _id } = req.user;
    if (role === ROLES.SUPER_ADMIN) return { clubId: null };
    if (role === ROLES.CLUB_ADMIN) return req.clubId ? { clubId: req.clubId } : { status: 403, message: "Your account is not linked to any club." };

    let record = null;
    if (role === ROLES.COACH) record = await Coach.findOne({ userId: _id }).select("clubId");
    else if (role === ROLES.PARENT) record = await Parent.findOne({ userId: _id }).select("clubId");
    else if ([ROLES.SENIOR_PLAYER, ROLES.YOUTH_PLAYER].includes(role)) record = await Player.findOne({ userId: _id }).select("clubId");

    return record?.clubId ? { clubId: record.clubId } : { status: 403, message: "Your account is not linked to any club." };
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
 * Notes ki list response (dono APIs ka same shape)
 */
const sendNotesPage = async (req, res, filter) => {
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
            notes: notes.map((n) => formatNote(n, req)),
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        },
    });
};

/**
 * GET /api/user/notes/coach?coachId=&clubId=&page=1&limit=20   (manager ya coach)
 * Coach notes. coachId = "All coaches" dropdown se ek coach.
 *   manager: apne club ke (superAdmin saare, ya clubId se ek club)
 *   coach:   sirf apne baare ke
 */
const listCoachNotes = async (req, res) => {
    try {
        const viewer = await getViewer(req);
        if (viewer.message) return sendError(res, viewer.status, viewer.message);

        const coachId = String(req.query.coachId || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        if (coachId && !isValidId(coachId)) return sendError(res, 400, "Invalid coach id.");

        const filter = { type: "coach" };
        if (coachId) filter.coachId = coachId;

        if (viewer.manager) {
            if (viewer.clubId) filter.clubId = viewer.clubId;
            else if (clubId) {
                if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
                filter.clubId = clubId;
            }
        } else {
            // Coach sirf apne baare ke notes. Kisi aur coach ki id di toh kuch nahi milega
            filter.clubId = viewer.clubId;
            filter.coachId = coachId && coachId !== String(viewer.coach._id) ? null : viewer.coach._id;
        }

        return await sendNotesPage(req, res, filter);
    } catch (e) {
        return sendServerError(res, "List coach notes", e);
    }
};

/**
 * GET /api/user/notes/player?playerId=&clubId=&page=1&limit=20   (koi bhi logged-in user)
 * Player notes. Kaun dekhega ye abhi tay nahi, isliye koi role rule nahi:
 * har user ko sirf APNE club ke player notes milte hain (superAdmin ko saare, ya clubId se ek club).
 * playerId = ek player ke notes.
 */
const listPlayerNotes = async (req, res) => {
    try {
        const club = await getUserClubId(req);
        if (club.message) return sendError(res, club.status, club.message);

        const playerId = String(req.query.playerId || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        if (playerId && !isValidId(playerId)) return sendError(res, 400, "Invalid player id.");

        const filter = { type: "player" };
        if (playerId) filter.playerId = playerId;

        if (club.clubId) filter.clubId = club.clubId;
        else if (clubId) {
            if (!isValidId(clubId)) return sendError(res, 400, "Invalid club id.");
            filter.clubId = clubId;
        }

        return await sendNotesPage(req, res, filter);
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
    if (!canView(viewer, note)) return { status: 404, message: "Note not found." };
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