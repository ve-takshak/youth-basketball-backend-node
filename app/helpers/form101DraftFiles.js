const mongoose = require("../../config/database");
const { encryptBuffer, decryptBuffer } = require("./secretBox");

// Form 101 ke documents (signature NAHI): ID card, ח ke documents, ט ka document, attachments.
// Client: bhara hua form 7 din rakho (status kuch bhi ho), taaki wapas aaye (returned) toh coach ko sab dobara na lagana pade.
// MongoDB GridFS bucket "form101DraftFiles", AES-256-GCM encrypted (PDF jaisa).
// Har file ke metadata mein expiresAt: sweepExpiredDraftFiles() purani files delete karta hai (index.js har ghante).
// Coach "shuru se" -> controller turant delete karta hai. Approve pe 7 din aur, phir sweep.

const BUCKET = "form101DraftFiles";
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
const toId = (id) => new mongoose.Types.ObjectId(String(id));

/** File encrypt karke save. @returns { fileId, field, filename, mimetype, size } */
const saveDraftFile = async (file, { field, coachId, year, expiresAt }) => {
    const box = encryptBuffer(file.data);
    const filename = String(file.name || "document").slice(0, 150);
    const fileId = await new Promise((resolve, reject) => {
        const upload = bucket().openUploadStream(filename, {
            metadata: { coachId, year, field, mimetype: file.mimetype, expiresAt, encrypted: true },
        });
        upload.once("error", reject);
        upload.once("finish", () => resolve(upload.id));
        upload.end(box);
    });
    return { fileId, field, filename, mimetype: file.mimetype, size: file.data.length };
};

/** Decrypted Buffer */
const readDraftFile = async (fileId) => {
    const chunks = [];
    await new Promise((resolve, reject) => {
        bucket()
            .openDownloadStream(toId(fileId))
            .on("data", (c) => chunks.push(c))
            .once("error", reject)
            .once("end", resolve);
    });
    return decryptBuffer(Buffer.concat(chunks));
};

/** Delete. Na mile toh chup (pehle hi delete). */
const deleteDraftFiles = async (fileIds = []) => {
    for (const id of fileIds) {
        if (!id) continue;
        try {
            await bucket().delete(toId(id));
        } catch (e) {
            if (!/FileNotFound|not found/i.test(e?.message || "")) console.error("Form 101 draft file delete failed:", e?.message || e);
        }
    }
};

/** Coach ki saari saved files ki expiry badlo (draft ki expiry ke saath) */
const setDraftFilesExpiry = (fileIds = [], expiresAt) =>
    fileIds.length
        ? mongoose.connection.db.collection(`${BUCKET}.files`).updateMany({ _id: { $in: fileIds.map(toId) } }, { $set: { "metadata.expiresAt": expiresAt } })
        : null;

/** expiresAt nikal gaya -> delete (file + chunks). index.js se har ghante. */
const sweepExpiredDraftFiles = async () => {
    try {
        const expired = await mongoose.connection.db
            .collection(`${BUCKET}.files`)
            .find({ "metadata.expiresAt": { $lte: new Date() } }, { projection: { _id: 1 } })
            .toArray();
        await deleteDraftFiles(expired.map((f) => f._id));
        return expired.length;
    } catch (e) {
        console.error("Form 101 draft files sweep failed:", e?.message || e);
        return 0;
    }
};

module.exports = { saveDraftFile, readDraftFile, deleteDraftFiles, setDraftFilesExpiry, sweepExpiredDraftFiles };
