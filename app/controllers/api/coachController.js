const mongoose = require("mongoose");
const validator = require("validator");
const User = require("../../models/User");
const Coach = require("../../models/Coach");
const Club = require("../../models/Club");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const cleanMobile = (mobile = "") => String(mobile).replace(/\D/g, "");


const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");


const formatCoach = (coach) => ({
    _id: coach._id,
    userId: coach.userId?._id || coach.userId,
    firstname: coach.userId?.firstname || "",
    lastname: coach.userId?.lastname || "",
    email: coach.userId?.email || "",
    countryCode: coach.userId?.countryCode || "",
    mobileNumber: coach.userId?.mobileNumber || "",
    is_verify: coach.userId?.is_verify || false,
    club: coach.clubId ? { _id: coach.clubId._id, name: coach.clubId.name } : null,
    createdAt: coach.createdAt,
});

const populateCoach = (query) =>
    query
        .populate("userId", "firstname lastname email countryCode mobileNumber is_verify")
        .populate("clubId", "name");


const createCoach = async (req, res) => {
    let user = null;
    try {
        let { firstname = "", lastname = "", email = "", countryCode = "+972", mobileNumber = "", clubId = "" } = req.body;

        firstname = String(firstname).trim();
        lastname = String(lastname).trim();
        email = String(email).trim().toLowerCase();
        mobileNumber = cleanMobile(mobileNumber);

        if (!firstname || !lastname) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "First name and last name are required.",
                message_desc: "First name and last name are required.",
                data: {},
            });
        }

        if (!mobileNumber || mobileNumber.length < 7) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Valid mobile number is required.",
                message_desc: "Valid mobile number is required.",
                data: {},
            });
        }

        if (email && !validator.isEmail(email)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please enter a valid email.",
                message_desc: "Please enter a valid email.",
                data: {},
            });
        }

        if (!isValidId(clubId)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Please select a valid club.",
                message_desc: "Please select a valid club.",
                data: {},
            });
        }

        const club = await Club.findById(clubId);
        if (!club) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Club not found.",
                message_desc: "Club not found.",
                data: {},
            });
        }

        const mobileExists = await User.findOne({ countryCode, mobileNumber });
        if (mobileExists) {
            return res.status(409).json({
                error: true,
                status: 409,
                message: "This mobile number is already registered.",
                message_desc: "This mobile number is already registered.",
                data: {},
            });
        }

        if (email) {
            const emailExists = await User.findOne({ email });
            if (emailExists) {
                return res.status(409).json({
                    error: true,
                    status: 409,
                    message: "This email is already registered.",
                    message_desc: "This email is already registered.",
                    data: {},
                });
            }
        }

        user = await User.create({
            firstname,
            lastname,
            email: email || undefined,
            countryCode,
            mobileNumber,
            role: "coach",
        });

        const coach = await Coach.create({
            userId: user._id,
            clubId: club._id,
            createdBy: req.user._id,
        });

        const saved = await populateCoach(Coach.findById(coach._id));

        return res.status(201).json({
            error: false,
            status: 201,
            message: "Coach created successfully.",
            message_desc: "Coach created successfully.",
            data: formatCoach(saved),
        });
    } catch (e) {
        // Coach record fail hua toh adhoora user bhi hata do
        if (user) await User.findByIdAndDelete(user._id).catch(() => { });
        console.error("Create coach error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

const listCoaches = async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const clubId = String(req.query.clubId || "").trim();
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);

        const filter = {};

        if (clubId) {
            if (!isValidId(clubId)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Invalid club id.",
                    message_desc: "Invalid club id.",
                    data: {},
                });
            }
            filter.clubId = clubId;
        }

        if (search) {
            const regex = new RegExp(escapeRegex(search), "i");
            const users = await User.find({
                role: "coach",
                $or: [{ firstname: regex }, { lastname: regex }, { mobileNumber: regex }],
            }).select("_id");
            filter.userId = { $in: users.map((u) => u._id) };
        }

        const [coaches, total] = await Promise.all([
            populateCoach(
                Coach.find(filter)
                    .sort({ createdAt: -1 })
                    .skip((page - 1) * limit)
                    .limit(limit)
            ),
            Coach.countDocuments(filter),
        ]);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coaches fetched successfully.",
            message_desc: "Coaches fetched successfully.",
            data: {
                coaches: coaches.map(formatCoach),
                pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
            },
        });
    } catch (e) {
        console.error("List coaches error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};


const updateCoach = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid coach id.",
                message_desc: "Invalid coach id.",
                data: {},
            });
        }

        const coach = await Coach.findById(id);
        if (!coach) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Coach not found.",
                message_desc: "Coach not found.",
                data: {},
            });
        }

        const user = await User.findById(coach.userId);
        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Coach user not found.",
                message_desc: "Coach user not found.",
                data: {},
            });
        }

        const { firstname, lastname, email, countryCode, mobileNumber, clubId } = req.body;

        if (firstname !== undefined) {
            if (!String(firstname).trim()) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "First name cannot be empty.",
                    message_desc: "First name cannot be empty.",
                    data: {},
                });
            }
            user.firstname = String(firstname).trim();
        }

        if (lastname !== undefined) {
            if (!String(lastname).trim()) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Last name cannot be empty.",
                    message_desc: "Last name cannot be empty.",
                    data: {},
                });
            }
            user.lastname = String(lastname).trim();
        }

        if (email !== undefined) {
            const newEmail = String(email).trim().toLowerCase();
            if (newEmail && !validator.isEmail(newEmail)) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please enter a valid email.",
                    message_desc: "Please enter a valid email.",
                    data: {},
                });
            }
            if (newEmail) {
                const emailExists = await User.findOne({ email: newEmail, _id: { $ne: user._id } });
                if (emailExists) {
                    return res.status(409).json({
                        error: true,
                        status: 409,
                        message: "This email is already registered.",
                        message_desc: "This email is already registered.",
                        data: {},
                    });
                }
            }
            user.email = newEmail || undefined;
        }

        if (mobileNumber !== undefined || countryCode !== undefined) {
            const newCode = countryCode !== undefined ? String(countryCode).trim() : user.countryCode;
            const newMobile = mobileNumber !== undefined ? cleanMobile(mobileNumber) : user.mobileNumber;

            if (!newMobile || newMobile.length < 7) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Valid mobile number is required.",
                    message_desc: "Valid mobile number is required.",
                    data: {},
                });
            }

            const mobileExists = await User.findOne({
                countryCode: newCode,
                mobileNumber: newMobile,
                _id: { $ne: user._id },
            });
            if (mobileExists) {
                return res.status(409).json({
                    error: true,
                    status: 409,
                    message: "This mobile number is already registered.",
                    message_desc: "This mobile number is already registered.",
                    data: {},
                });
            }

            user.countryCode = newCode;
            user.mobileNumber = newMobile;
        }

        if (clubId !== undefined) {
            if (!isValidId(clubId) || !(await Club.exists({ _id: clubId }))) {
                return res.status(400).json({
                    error: true,
                    status: 400,
                    message: "Please select a valid club.",
                    message_desc: "Please select a valid club.",
                    data: {},
                });
            }
            coach.clubId = clubId;
        }

        await user.save();
        await coach.save();

        const saved = await populateCoach(Coach.findById(coach._id));

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach updated successfully.",
            message_desc: "Coach updated successfully.",
            data: formatCoach(saved),
        });
    } catch (e) {
        console.error("Update coach error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};


const deleteCoach = async (req, res) => {
    try {
        const { id } = req.params;

        if (!isValidId(id)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid coach id.",
                message_desc: "Invalid coach id.",
                data: {},
            });
        }

        const coach = await Coach.findByIdAndDelete(id);
        if (!coach) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Coach not found.",
                message_desc: "Coach not found.",
                data: {},
            });
        }

        await User.findByIdAndDelete(coach.userId);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Coach deleted successfully.",
            message_desc: "Coach deleted successfully.",
            data: { _id: coach._id },
        });
    } catch (e) {
        console.error("Delete coach error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};

module.exports = { createCoach, listCoaches, updateCoach, deleteCoach };
