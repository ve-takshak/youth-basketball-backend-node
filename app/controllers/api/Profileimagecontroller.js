const path = require("path");
const User = require("../../models/User");
const Player = require("../../models/Player");
const Coach = require("../../models/Coach");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { upload_files, deleteFiles } = require("../../../utils/s3");

// Profile image: sirf image, max 5MB, S3 ke "profiles" folder mein (club logo jaisa)
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// Admin sirf in roles ki image badal sakta hai
const ADMIN_EDITABLE_ROLES = [ROLES.SENIOR_PLAYER, ROLES.YOUTH_PLAYER, ROLES.COACH];

const getS3BaseUrl = () =>
    `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`;

// req.files.profile_image check karna (express-fileupload)
const getImageFile = (req) => {
    const file = req.files?.profile_image;
    if (!file) return { error: "Please select an image." };
    if (Array.isArray(file)) return { error: "Only one image is allowed." };
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
        return { error: "Profile image must be a PNG, JPG or WEBP image." };
    }
    if (file.size > MAX_IMAGE_SIZE) return { error: "Profile image must be 5MB or smaller." };
    // File ka naam simple (Hebrew / special characters URL na todein)
    const ext = path.extname(file.name || "").toLowerCase() || ".jpg";
    file.name = `profile${ext}`;
    return { file };
};

// Purani image S3 se hatana (sirf apne bucket ki)
const removeImage = async (url) => {
    if (!url) return;
    try {
        const baseUrl = getS3BaseUrl();
        if (!url.startsWith(baseUrl)) return;
        const key = url.replace(baseUrl, "");
        const slash = key.lastIndexOf("/");
        const result = await deleteFiles(key.slice(0, slash), key.slice(slash + 1));
        if (result !== 1) console.warn("Failed to delete profile image from S3:", result);
    } catch (err) {
        console.warn("Failed to delete profile image:", err.message);
    }
};

/**
 * Nayi image upload karke user pe lagana, ya remove=true pe hatana.
 * Response mein { _id, role, profile_image }
 */
const saveProfileImage = async (req, res, user) => {
    const oldImage = user.profile_image || "";

    // Image hatani hai
    if (String(req.body?.remove) === "true") {
        user.profile_image = "";
        await user.save();
        await removeImage(oldImage);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Profile image removed successfully.",
            message_desc: "Profile image removed successfully.",
            data: { _id: user._id, role: user.role, profile_image: "" },
        });
    }

    const check = getImageFile(req);
    if (check.error) {
        return res.status(400).json({
            error: true,
            status: 400,
            message: check.error,
            message_desc: check.error,
            data: {},
        });
    }

    const uploaded = await upload_files("profiles", check.file);
    if (!uploaded) {
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Image upload failed. Please try again.",
            message_desc: "Image upload failed. Please try again.",
            data: {},
        });
    }

    try {
        user.profile_image = uploaded;
        await user.save();
    } catch (e) {
        await removeImage(uploaded); // save fail hua toh nayi image bhi hatao
        throw e;
    }

    // Save ho gaya, ab purani image hatao
    await removeImage(oldImage);

    return res.status(200).json({
        error: false,
        status: 200,
        message: "Profile image updated successfully.",
        message_desc: "Profile image updated successfully.",
        data: { _id: user._id, role: user.role, profile_image: uploaded },
    });
};

/**
 * PUT /api/user/profile/image   (koi bhi logged-in user: player, coach, parent, admin)
 * Apni khud ki profile image (mobile app / web panel).
 * form-data: profile_image (file)   ya   remove=true (image hatani ho toh)
 */
const updateMyProfileImage = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "User not found.",
                message_desc: "User not found.",
                data: {},
            });
        }
        return await saveProfileImage(req, res, user);
    } catch (e) {
        console.error("Update my profile image error:", e);
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
 * PUT /api/user/users/:userId/profile-image   (superAdmin ya clubAdmin)
 * Admin kisi player ya coach ki profile image badle.
 * :userId = us player / coach ka userId (player/coach response mein "userId" aata hai)
 * clubAdmin sirf apne club ke player / coach ki image badal sakta hai.
 * form-data: profile_image (file)   ya   remove=true
 */
const updateUserProfileImage = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!isValidId(userId)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid user id.",
                message_desc: "Invalid user id.",
                data: {},
            });
        }

        const user = await User.findById(userId);
        if (!user || !ADMIN_EDITABLE_ROLES.includes(user.role)) {
            return res.status(404).json({
                error: true,
                status: 404,
                message: "Player or coach not found.",
                message_desc: "Player or coach not found.",
                data: {},
            });
        }

        // clubAdmin: player / coach usi ke club ka hona chahiye
        if (req.user.role === ROLES.CLUB_ADMIN) {
            const record =
                user.role === ROLES.COACH
                    ? await Coach.findOne({ userId: user._id }).select("clubId")
                    : await Player.findOne({ userId: user._id }).select("clubId");

            if (!record || String(record.clubId) !== String(req.clubId)) {
                return res.status(404).json({
                    error: true,
                    status: 404,
                    message: "Player or coach not found.",
                    message_desc: "Player or coach not found.",
                    data: {},
                });
            }
        }

        return await saveProfileImage(req, res, user);
    } catch (e) {
        console.error("Update user profile image error:", e);
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
 * DELETE /api/user/:userId/profile-image   (koi bhi logged-in user)
 *
 * :userId = apni id        -> apni khud ki profile image hatana (player, coach, parent, admin)
 * :userId = kisi aur ki id -> sirf admin (superAdmin / clubAdmin), aur wo player ya coach hona chahiye
 *                             (clubAdmin sirf apne club ka)
 */

// Admin ke liye: player / coach dhoondhna + clubAdmin ka club check.
// Mile toh { user }, warna { status, message }
const findEditableUser = async (req, userId) => {
    if (!isValidId(userId)) return { status: 400, message: "Invalid user id." };

    const user = await User.findById(userId);
    if (!user || !ADMIN_EDITABLE_ROLES.includes(user.role)) {
        return { status: 404, message: "Player or coach not found." };
    }

    // clubAdmin: player / coach usi ke club ka hona chahiye
    if (req.user.role === ROLES.CLUB_ADMIN) {
        const record =
            user.role === ROLES.COACH
                ? await Coach.findOne({ userId: user._id }).select("clubId")
                : await Player.findOne({ userId: user._id }).select("clubId");

        if (!record || String(record.clubId) !== String(req.clubId)) {
            return { status: 404, message: "Player or coach not found." };
        }
    }

    return { user };
};

// Image hatana: DB se khaali, phir S3 se file delete
const clearProfileImage = async (res, user) => {
    if (!user.profile_image) {
        return res.status(400).json({
            error: true,
            status: 400,
            message: "No profile image to remove.",
            message_desc: "No profile image to remove.",
            data: {},
        });
    }

    const oldImage = user.profile_image;
    user.profile_image = "";
    await user.save();
    await removeImage(oldImage);

    return res.status(200).json({
        error: false,
        status: 200,
        message: "Profile image removed successfully.",
        message_desc: "Profile image removed successfully.",
        data: { _id: user._id, role: user.role, profile_image: "" },
    });
};

const removeProfileImage = async (req, res) => {
    try {
        const userId = String(req.params.userId || "").trim();

        if (!isValidId(userId)) {
            return res.status(400).json({
                error: true,
                status: 400,
                message: "Invalid user id.",
                message_desc: "Invalid user id.",
                data: {},
            });
        }

        // ---- Apni image ----
        if (userId === String(req.user._id)) {
            const user = await User.findById(req.user._id);
            if (!user) {
                return res.status(404).json({
                    error: true,
                    status: 404,
                    message: "User not found.",
                    message_desc: "User not found.",
                    data: {},
                });
            }
            return await clearProfileImage(res, user);
        }

        // ---- Kisi aur ki image: sirf admin ----
        if (![ROLES.SUPER_ADMIN, ROLES.CLUB_ADMIN].includes(req.user.role)) {
            return res.status(403).json({
                error: true,
                status: 403,
                message: "Access denied. Super admin or club admin only.",
                message_desc: "Access denied. Super admin or club admin only.",
                data: {},
            });
        }

        const result = await findEditableUser(req, userId);
        if (result.message) {
            return res.status(result.status).json({
                error: true,
                status: result.status,
                message: result.message,
                message_desc: result.message,
                data: {},
            });
        }
        return await clearProfileImage(res, result.user);
    } catch (e) {
        console.error("Remove profile image error:", e);
        return res.status(500).json({
            error: true,
            status: 500,
            message: "Something went wrong.",
            message_desc: e.message,
            data: {},
        });
    }
};


module.exports = { updateMyProfileImage, updateUserProfileImage, removeProfileImage };