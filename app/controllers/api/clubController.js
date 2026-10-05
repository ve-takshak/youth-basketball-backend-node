const mongoose = require("mongoose");
const Club = require("../../models/Club");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const isHexColor = (color) => /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color);

// Regex ke special characters escape karna (search aur name check ke liye)
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// theme object se sirf valid colors nikalta hai, galat ho toh error message deta hai
const pickTheme = (theme = {}) => {
    const result = {};
    for (const key of ["primary", "secondary", "background"]) {
        if (theme[key] === undefined || theme[key] === "") continue;
        if (!isHexColor(theme[key])) return { error: `Invalid ${key} color. Use format like #1E40AF.` };
        result[key] = theme[key];
    }
    return { theme: result };
};



const createClub = async (req, res) => {
    try {
        let { name = "", logo = "", theme = {} } = req.body;
        name = String(name).trim();

        if (!name) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Club name is required.",
                message_desc: "Club name is required.",
                data: {},
            });
        }

        const nameExists = await Club.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, "i") });
        if (nameExists) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "A club with this name already exists.",
                message_desc: "A club with this name already exists.",
                data: {},
            });
        }

        const picked = pickTheme(theme);
        if (picked.error) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: picked.error,
                message_desc: picked.error,
                data: {},
            });
        }

        const club = await Club.create({
            name,
            logo: String(logo).trim(),
            theme: picked.theme,
            createdBy: req.user._id, // token se aaya admin
        });

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Club created successfully.",
            message_desc: "Club created successfully.",
            data: club,
        });
    } catch (e) {
        console.error("Create club error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};


const listClubs = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);

        const filter = {};
        if (search) filter.name = new RegExp(escapeRegex(search), "i");

        const [clubs, total] = await Promise.all([
            Club.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate("createdBy", "firstname lastname mobileNumber"),
            Club.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Clubs fetched successfully.",
            message_desc: "Clubs fetched successfully.",
            data: {
                clubs,
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        console.error("List clubs error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};


const updateClub = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club id.",
                message_desc: "Invalid club id.",
                data: {},
            });
        }

        const club = await Club.findById(id);
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        const { name, logo, theme } = req.body;

        if (name !== undefined) {
            const newName = String(name).trim();

            if (!newName) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Club name cannot be empty.",
                    message_desc: "Club name cannot be empty.",
                    data: {},
                });
            }

            const nameExists = await Club.findOne({
                _id: { $ne: id },
                name: new RegExp(`^${escapeRegex(newName)}$`, "i"),
            });
            if (nameExists) {
                return res.status(409).json({
                    error: true,
                    status: 409,
                    message: "A club with this name already exists.",
                    message_desc: "A club with this name already exists.",
                    data: {},
                });
            }

            club.name = newName;
        }

        if (logo !== undefined) club.logo = String(logo).trim();

        if (theme !== undefined) {
            const picked = pickTheme(theme);
            if (picked.error) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: picked.error,
                    message_desc: picked.error,
                    data: {},
                });
            }
            // Sirf bheje gaye colors update honge, baaki purane rahenge
            Object.assign(club.theme, picked.theme);
        }

        await club.save();

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club updated successfully.",
            message_desc: "Club updated successfully.",
            data: club,
        });
    } catch (e) {
        console.error("Update club error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};


const deleteClub = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid club id.",
                message_desc: "Invalid club id.",
                data: {},
            });
        }

        const club = await Club.findByIdAndDelete(id);
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Club deleted successfully.",
            message_desc: "Club deleted successfully.",
            data: { _id: club._id },
        });
    } catch (e) {
        console.error("Delete club error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { createClub, listClubs, updateClub, deleteClub };