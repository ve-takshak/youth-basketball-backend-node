const mongoose = require("mongoose");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// Mobile number clean: sirf digits
const cleanMobile = (mobile = "") => String(mobile).replace(/\D/g, "");

// Regex ke special characters escape karna (search ke liye)
const escapeRegex = (text = "") => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Pagination query se page/limit nikalna
const getPagination = (query) => {
    const page = Math.max(parseInt(query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit) || 10, 1), 100);
    return { page, limit, skip: (page - 1) * limit };
};

module.exports = { isValidId, cleanMobile, escapeRegex, getPagination };
