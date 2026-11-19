const mongoose = require("../../config/database");
const { encryptBuffer, decryptBuffer } = require("./secretBox");

// Form 101 PDF ka storage: MongoDB GridFS (bucket "form101Pdfs"), AES-256-GCM se encrypted.
// GridFS isliye kyunki documents ke saath PDF 16MB (Mongo document limit) se badi ho sakti hai.
// Download sirf club admin (apna club) + super admin (controller check karta hai). Coach ko nahi.
// Key: .env PAYMENT_ENCRYPTION_KEY (bank details wali). Key badli toh purani PDFs nahi khulengi.

const BUCKET = "form101Pdfs";
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

class Form101StorageError extends Error {}

/** PDF encrypt karke save. @returns GridFS file id */
const savePdf = async (pdf, { filename, coachId, clubId, year }) => {
    let box;
    try {
        box = encryptBuffer(pdf);
    } catch (e) {
        throw new Form101StorageError(e.message); // jaise PAYMENT_ENCRYPTION_KEY set nahi
    }
    return new Promise((resolve, reject) => {
        const upload = bucket().openUploadStream(filename, { metadata: { coachId, clubId, year, encrypted: true } });
        upload.once("error", reject);
        upload.once("finish", () => resolve(upload.id));
        upload.end(box);
    });
};

/** Decrypted PDF Buffer */
const readPdf = async (fileId) => {
    const chunks = [];
    await new Promise((resolve, reject) => {
        bucket()
            .openDownloadStream(new mongoose.Types.ObjectId(String(fileId)))
            .on("data", (c) => chunks.push(c))
            .once("error", reject)
            .once("end", resolve);
    });
    return decryptBuffer(Buffer.concat(chunks));
};

/** File delete. Na mile toh chup (pehle hi delete ho chuki). */
const deletePdf = async (fileId) => {
    if (!fileId) return;
    try {
        await bucket().delete(new mongoose.Types.ObjectId(String(fileId)));
    } catch (e) {
        if (!/FileNotFound|not found/i.test(e?.message || "")) console.error("Form 101 PDF delete failed:", e?.message || e);
    }
};

module.exports = { savePdf, readPdf, deletePdf, Form101StorageError };
