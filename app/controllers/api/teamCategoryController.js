const TeamCategory = require("../../models/TeamCategory");
const { isValidId, escapeRegex, getPagination } = require("../../helpers/common");

/**
 * Format category object for API response
 */
const formatCategory = (category) => {
    if (!category) return null;
    return {
        _id: category._id,
        name: category.name,
        createdBy: category.createdBy,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
    };
};

/**
 * POST /api/user/createTeamCategory
 * Body: { name }
 */
const createTeamCategory = async (req, res) => {
    try {
        const { name } = req.body;

        if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Category name is required.",
                message_desc: "Category name is required.",
                data: {},
            });
        }

        const trimmedName = name.trim();
        if (trimmedName.length < 2) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Category name must be at least 2 characters.",
                message_desc: "Category name must be at least 2 characters.",
                data: {},
            });
        }

        // Duplicate check (case-insensitive)
        const existing = await TeamCategory.findOne({
            name: new RegExp(`^${escapeRegex(trimmedName)}$`, "i"),
        });

        if (existing) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "A team category with this name already exists.",
                message_desc: "A team category with this name already exists.",
                data: {},
            });
        }

        const category = await TeamCategory.create({
            name: trimmedName,
            createdBy: req.user ? req.user._id : null,
        });

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Team category created successfully.",
            message_desc: "Team category created successfully.",
            data: formatCategory(category),
        });
    } catch (e) {
        console.error("Create team category error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * GET /api/user/listTeamCategories
 * Query: { search?, page?, limit? }
 */
const listTeamCategories = async (req, res) => {
    try {
        const { search } = req.query;
        const filter = {};

        if (search && String(search).trim()) {
            filter.name = new RegExp(escapeRegex(String(search).trim()), "i");
        }

        const total = await TeamCategory.countDocuments(filter);

        let query = TeamCategory.find(filter).sort({ name: 1 });

        // If pagination params are explicitly passed
        if (req.query.page || req.query.limit) {
            const { page, limit, skip } = getPagination(req.query);
            query = query.skip(skip).limit(limit);
            const categories = await query;
            return res.status(200).json({
                error: false,
                status: 200,
                message: "Team categories fetched successfully.",
                message_desc: "Team categories fetched successfully.",
                data: {
                    categories: categories.map(formatCategory),
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit) || 1,
                    },
                },
            });
        }

        const categories = await query;
        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team categories fetched successfully.",
            message_desc: "Team categories fetched successfully.",
            data: {
                categories: categories.map(formatCategory),
                total,
            },
        });
    } catch (e) {
        console.error("List team categories error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * GET /api/user/getTeamCategory/:id
 */
const getTeamCategory = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid team category id.",
                message_desc: "Invalid team category id.",
                data: {},
            });
        }

        const category = await TeamCategory.findById(id);
        if (!category) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Team category not found.",
                message_desc: "Team category not found.",
                data: {},
            });
        }

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team category fetched successfully.",
            message_desc: "Team category fetched successfully.",
            data: formatCategory(category),
        });
    } catch (e) {
        console.error("Get team category error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * PUT /api/user/updateTeamCategory/:id
 * Body: { name }
 */
const updateTeamCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid team category id.",
                message_desc: "Invalid team category id.",
                data: {},
            });
        }

        const category = await TeamCategory.findById(id);
        if (!category) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Team category not found.",
                message_desc: "Team category not found.",
                data: {},
            });
        }

        if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Category name is required.",
                message_desc: "Category name is required.",
                data: {},
            });
        }

        const trimmedName = name.trim();
        if (trimmedName.length < 2) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Category name must be at least 2 characters.",
                message_desc: "Category name must be at least 2 characters.",
                data: {},
            });
        }

        // Duplicate check excluding self
        const existing = await TeamCategory.findOne({
            _id: { $ne: id },
            name: new RegExp(`^${escapeRegex(trimmedName)}$`, "i"),
        });

        if (existing) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "A team category with this name already exists.",
                message_desc: "A team category with this name already exists.",
                data: {},
            });
        }

        category.name = trimmedName;
        await category.save();

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team category updated successfully.",
            message_desc: "Team category updated successfully.",
            data: formatCategory(category),
        });
    } catch (e) {
        console.error("Update team category error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

/**
 * DELETE /api/user/deleteTeamCategory/:id
 */
const deleteTeamCategory = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid team category id.",
                message_desc: "Invalid team category id.",
                data: {},
            });
        }

        const category = await TeamCategory.findById(id);
        if (!category) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Team category not found.",
                message_desc: "Team category not found.",
                data: {},
            });
        }

        await TeamCategory.findByIdAndDelete(id);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Team category deleted successfully.",
            message_desc: "Team category deleted successfully.",
            data: { _id: id, name: category.name },
        });
    } catch (e) {
        console.error("Delete team category error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = {
    createTeamCategory,
    listTeamCategories,
    getTeamCategory,
    updateTeamCategory,
    deleteTeamCategory,
};
