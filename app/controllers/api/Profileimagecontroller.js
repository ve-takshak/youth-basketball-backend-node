const path = require("path");
const User = require("../../models/User");
const Player = require("../../models/Player");
const Coach = require("../../models/Coach");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { upload_files, deleteFiles } = require("../../../utils/s3");

// Profile image: sirf image, max 5MB, S3 ke "profiles" folder mein (club logo jaisa)
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const ALLOWED_IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// Admin sirf in roles ki image badal sakta hai
const ADMIN_EDITABLE_ROLES = [ROLES.SENIOR_PLAYER, ROLES.YOUTH_PLAYER, ROLES.COACH];

const getS3BaseUrl = () =>
    `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`;

const sendError = (res, status, message) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data: {} });

// req.files.profile_image check karna (express-fileupload)
const getImageFile = (req) => {
    const file = req.files?.profile_image;
    if (!file) return { error: "Please select an image." };
    if (Array.isArray(file)) return { error: "Only one image is allowed." };

    const ext = path.extname(file.name || "").toLowerCase();
    const okByType = ALLOWED_IMAGE_TYPES.includes(file.mimetype);
    // Mobile apps (Flutter / Dio) kabhi kabhi "application/octet-stream" bhejte hain, tab extension se check
    const okByExt = file.mimetype === "application/octet-stream" && ALLOWED_IMAGE_EXTS.includes(ext);
    if (!okByType && !okByExt) return { error: "Profile image must be a PNG, JPG or WEBP image." };

    if (file.size > MAX_IMAGE_SIZE) return { error: "Profile image must be 5MB or smaller." };

    // File ka naam simple (Hebrew / special characters URL na todein)
    file.name = `profile${ext || ".jpg"}`;
    return { file };
};

// Image S3 se hatana (sirf apne bucket ki)
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
 * Kaun kiski image badal sakta hai:
 *   apni id          -> koi bhi logged-in user (player, coach, parent, admin)
 *   kisi aur ki id   -> sirf superAdmin / clubAdmin, aur wo player ya coach ho
 *                       (clubAdmin sirf apne club ka)
 * Mile toh { user }, warna { status, message }
 */
const findTargetUser = async (req, userId) => {
    if (!isValidId(userId)) return { status: 400, message: "Invalid user id." };

    // Apni image
    if (String(userId) === String(req.user._id)) {
        const me = await User.findById(req.user._id);
        if (!me) return { status: 404, message: "User not found." };
        return { user: me };
    }

    // Kisi aur ki image: sirf admin
    if (![ROLES.SUPER_ADMIN, ROLES.CLUB_ADMIN].includes(req.user.role)) {
        return { status: 403, message: "You can only change your own profile image." };
    }

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

/**
 * PUT /api/user/:userId/profile-image   (authentication: koi bhi logged-in user)
 * form-data: profile_image (file)   — PNG / JPG / WEBP, max 5MB
 * :userId = User ki _id (apni ya, admin ho toh player / coach ki)
 */
const updateProfileImage = async (req, res) => {
    let uploaded = "";
    try {
        const target = await findTargetUser(req, String(req.params.userId || "").trim());
        if (target.message) return sendError(res, target.status, target.message);
        const user = target.user;

        const check = getImageFile(req);
        if (check.error) return sendError(res, 400, check.error);

        uploaded = await upload_files("profiles", check.file);
        if (!uploaded) return sendError(res, 500, "Image upload failed. Please try again.");

        const oldImage = user.profile_image || "";
        user.profile_image = uploaded;
        await user.save();

        // Save ho gaya, ab purani image hatao
        await removeImage(oldImage);

        return res.status(200).json({
            error: false,
            status: 200,
            message: "Profile image updated successfully.",
            message_desc: "Profile image updated successfully.",
            data: { _id: user._id, role: user.role, profile_image: uploaded },
        });
    } catch (e) {
        if (uploaded) await removeImage(uploaded); // save fail hua toh nayi image bhi hatao
        console.error("Update profile image error:", e);
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
 * DELETE /api/user/:userId/profile-image   (authentication: koi bhi logged-in user)
 * :userId = User ki _id (apni ya, admin ho toh player / coach ki)
 */
const removeProfileImage = async (req, res) => {
    try {
        const target = await findTargetUser(req, String(req.params.userId || "").trim());
        if (target.message) return sendError(res, target.status, target.message);
        const user = target.user;

        if (!user.profile_image) return sendError(res, 400, "No profile image to remove.");

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

module.exports = { updateProfileImage, removeProfileImage };