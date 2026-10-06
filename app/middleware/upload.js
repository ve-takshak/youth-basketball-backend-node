const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Ensure upload directory exists
const uploadDir = path.join(__dirname, "../../uploads/clubs");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeName = path
            .basename(file.originalname, ext)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "-")
            .substring(0, 30);
        const uniqueName = `club-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
        cb(null, uniqueName);
    },
});

const fileFilter = (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|svg\+xml|svg/;
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();

    if (allowed.test(ext) || allowed.test(mime)) {
        cb(null, true);
    } else {
        cb(new Error("Only images (PNG, JPG, JPEG, WEBP, SVG) are allowed for club logo."));
    }
};

const uploadClubLogo = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter,
});

module.exports = { uploadClubLogo };
