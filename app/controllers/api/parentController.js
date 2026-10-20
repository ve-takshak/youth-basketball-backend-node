const Club = require("../../models/Club");
const Parent = require("../../models/Parent");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");

const formatParentClub = (parent, club) => ({
    parentId: parent._id,
    club: {
        _id: club._id,
        clubCode: club.clubCode || "",
        name: club.name,
        theme: club.theme,
    },
    joinedAt: parent.createdAt,
});

/**
 * POST /api/user/parent/selectClub   (logged-in parent)
 * body: { clubId } ya { clubCode }
 * Parent ko club se jodta hai. Ek parent ka ek hi club.
 */
const selectParentClub = async (req, res) => {
    try {
        const user = req.user;

        if (user.role !== ROLES.PARENT) {
            return res.status(403).json({
                error: true,
                status: 403,
                message: "Only parents can select a club.",
                message_desc: "Only parents can select a club.",
                data: {},
            });
        }

        const clubId = String(req.body.clubId || "").trim();
        const clubCode = String(req.body.clubCode || "").trim().toUpperCase();

        // ---- 1. Club dhundo (id ya code se) ----
        let club = null;
        if (clubId) {
            if (!isValidId(clubId)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please select a valid club.",
                    message_desc: "Please select a valid club.",
                    data: {},
                });
            }
            club = await Club.findById(clubId).select("_id clubCode name theme");
        } else if (clubCode) {
            club = await Club.findOne({ clubCode }).select("_id clubCode name theme");
        } else {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please select a club.",
                message_desc: "Please select a club.",
                data: {},
            });
        }

        if (!club) {
            const message = clubCode ? "Invalid club code." : "Club not found.";
            return res.status(404).json({
                error: true,
                status: 404,
                message,
                message_desc: message,
                data: {},
            });
        }

        // ---- 2. Pehle se kisi club se juda hai? ----
        const existing = await Parent.findOne({ userId: user._id });
        if (existing) {
            if (String(existing.clubId) === String(club._id)) {
                // Same club dobara: koi problem nahi, wahi wapas bhej do
                return res.status(200).json({
                    error: false,
                    status: 200,
                    message: "You are already linked to this club.",
                    message_desc: "You are already linked to this club.",
                    data: formatParentClub(existing, club),
                });
            }
            return res.status(409).json({
                error: true,
                status: 409,
                message: "You are already linked to another club. Please contact the club admin to change it.",
                message_desc: "You are already linked to another club. Please contact the club admin to change it.",
                data: {},
            });
        }

        // ---- 3. Link banao ----
        const parent = await Parent.create({
            userId: user._id,
            clubId: club._id,
            createdBy: user._id, // self-join
        });

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Club selected successfully.",
            message_desc: "Club selected successfully.",
            data: formatParentClub(parent, club),
        });
    } catch (e) {
        // Do request ek saath aayi (double tap) toh unique index rok dega
        if (e.code === 11000) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "Club is already being linked. Please refresh.",
                message_desc: "Club is already being linked. Please refresh.",
                data: {},
            });
        }
        console.error("Select parent club error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { selectParentClub };