// One-time migration: purane player ID / passport scans ko private + KMS + UUID naam par le jaana.
//
// Purana: Player.idDocument = "https://<bucket>.s3.<region>.amazonaws.com/players/<timestamp>_id-document.jpg"
//         (public URL, naam guess ho sakta hai, KMS nahi)
// Naya:   Player.idDocument = "id-documents/<uuid>.jpg"  (sirf key, KMS se encrypted, signed URL se hi khulta hai)
//
// Har purane document ke liye:
//   1. S3 mein nayi key par copy (KMS key se encrypt, content-type wahi)
//   2. DB mein Player.idDocument = nayi key
//   3. Purani public file delete
// Copy fail ho toh DB aur purani file waise hi rehti hain (kuch nahi tootta). Dobara chalana safe hai.
//
// Chalana (backend folder se, .env ka MONGODB_URI / AWS_* / S3_BUCKET / S3_KMS_KEY_ID):
//   node scripts/migratePlayerIdDocuments.js                    -> DRY RUN: sirf batata hai, kuch nahi badalta
//   node scripts/migratePlayerIdDocuments.js --apply            -> asli migration
//   node scripts/migratePlayerIdDocuments.js --apply --delete-orphans
//        -> saath mein bucket ke wo purane "players/<timestamp>_id-document.*" bhi delete
//           jo kisi player se jude nahi (adhoore uploads). Iske liye IAM mein s3:ListBucket chahiye.
require("dotenv").config();
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const {
    S3Client,
    CopyObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const APPLY = process.argv.includes("--apply");
const DELETE_ORPHANS = process.argv.includes("--delete-orphans");

const { AWS_REGION, S3_BUCKET, S3_KMS_KEY_ID } = process.env;
const NEW_FOLDER = "id-documents";
const BASE_URL = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/`;
// Purane ID document ka naam (Playercontroller / parentController dono yahi banate the)
const OLD_DOC_KEY = /^players\/\d+_id-document\.[a-z0-9]+$/i;

const s3 = new S3Client({
    region: AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const kms = { ServerSideEncryption: "aws:kms", SSEKMSKeyId: S3_KMS_KEY_ID, BucketKeyEnabled: true };
const newKeyFor = (oldName) => `${NEW_FOLDER}/${crypto.randomUUID()}${path.extname(oldName).toLowerCase()}`;
const tag = (player) => `player ${player._id}`;

const MIME_BY_EXT = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// S3 wala purana document: copy -> DB -> delete
const migrateS3Doc = async (players, player, oldKey) => {
    const newKey = newKeyFor(oldKey);
    if (!APPLY) {
        console.log(`would move  ${tag(player)}: ${oldKey} -> ${newKey}`);
        return "planned";
    }

    try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: oldKey }));
    } catch (e) {
        if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
            console.warn(`MISSING     ${tag(player)}: ${oldKey} S3 mein nahi hai, DB nahi badla`);
            return "missing";
        }
        throw e;
    }

    await s3.send(new CopyObjectCommand({
        Bucket: S3_BUCKET,
        Key: newKey,
        CopySource: encodeURIComponent(`${S3_BUCKET}/${oldKey}`),
        MetadataDirective: "COPY", // content-type wahi rahe
        ...kms,
    }));

    const result = await players.updateOne(
        { _id: player._id, idDocument: player.idDocument }, // beech mein kisi ne badla ho toh overwrite nahi
        { $set: { idDocument: newKey } }
    );
    if (result.modifiedCount !== 1) {
        await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: newKey }));
        console.warn(`SKIPPED     ${tag(player)}: document beech mein badal gaya, kuch nahi kiya`);
        return "skipped";
    }

    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: oldKey }));
    console.log(`moved       ${tag(player)}: ${oldKey} -> ${newKey}`);
    return "moved";
};

// Bahut purana local disk wala document (uploads/...): S3 par private upload -> DB -> local file delete
const migrateLocalDoc = async (players, player) => {
    const filePath = path.resolve(__dirname, "..", player.idDocument);
    if (!fs.existsSync(filePath)) {
        console.warn(`MISSING     ${tag(player)}: local file ${player.idDocument} nahi mili, DB nahi badla`);
        return "missing";
    }
    const newKey = newKeyFor(filePath);
    if (!APPLY) {
        console.log(`would upload ${tag(player)}: ${player.idDocument} -> ${newKey}`);
        return "planned";
    }
    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: newKey,
        Body: fs.readFileSync(filePath),
        ContentType: MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        ...kms,
    }));
    await players.updateOne({ _id: player._id }, { $set: { idDocument: newKey } });
    fs.unlinkSync(filePath);
    console.log(`uploaded    ${tag(player)}: ${player.idDocument} -> ${newKey}`);
    return "moved";
};

// Bucket mein bache purane "players/<timestamp>_id-document.*" jo kisi player se jude nahi
const handleOrphans = async (players) => {
    const referenced = new Set(
        (await players.find({ idDocument: { $regex: `^${BASE_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}` } })
            .project({ idDocument: 1 }).toArray())
            .map((p) => p.idDocument.slice(BASE_URL.length))
    );

    const orphans = [];
    let token;
    do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: "players/", ContinuationToken: token }));
        (page.Contents || []).forEach((obj) => {
            if (OLD_DOC_KEY.test(obj.Key) && !referenced.has(obj.Key)) orphans.push(obj.Key);
        });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    console.log(`\nOrphan ID documents (kisi player se nahi jude): ${orphans.length}`);
    for (const key of orphans) {
        if (APPLY && DELETE_ORPHANS) {
            await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
            console.log(`deleted orphan ${key}`);
        } else {
            console.log(`orphan      ${key}`);
        }
    }
    if (orphans.length && !(APPLY && DELETE_ORPHANS)) {
        console.log("(delete karne ke liye: --apply --delete-orphans)");
    }
};

(async () => {
    if (!S3_BUCKET || !AWS_REGION) throw new Error("S3_BUCKET / AWS_REGION .env mein nahi hai.");
    if (!S3_KMS_KEY_ID) throw new Error("S3_KMS_KEY_ID .env mein nahi hai.");

    console.log(APPLY ? "=== APPLY: asli migration ===\n" : "=== DRY RUN: kuch nahi badlega (asli ke liye --apply) ===\n");

    await mongoose.connect(process.env.MONGODB_URI);
    const players = mongoose.connection.db.collection("players");

    // Jo pehle se naye format mein hain (id-documents/...) unhe chhodo
    const pending = await players
        .find({ idDocument: { $nin: ["", null], $not: new RegExp(`^${NEW_FOLDER}/`) } })
        .project({ idDocument: 1 })
        .toArray();

    console.log(`Purane format wale documents: ${pending.length}\n`);

    const counts = { moved: 0, planned: 0, missing: 0, skipped: 0, failed: 0, unknown: 0 };
    for (const player of pending) {
        try {
            let outcome;
            if (player.idDocument.startsWith(BASE_URL)) {
                outcome = await migrateS3Doc(players, player, decodeURIComponent(player.idDocument.slice(BASE_URL.length)));
            } else if (!player.idDocument.startsWith("http")) {
                outcome = await migrateLocalDoc(players, player);
            } else {
                console.warn(`UNKNOWN     ${tag(player)}: hamare bucket ka URL nahi hai (${player.idDocument}), chhod diya`);
                outcome = "unknown";
            }
            counts[outcome] += 1;
        } catch (e) {
            counts.failed += 1;
            console.error(`FAILED      ${tag(player)}: ${e.name}: ${e.message}`);
        }
    }

    console.log("\nSummary:", JSON.stringify(counts));

    try {
        await handleOrphans(players);
    } catch (e) {
        console.warn(`\nOrphan check nahi ho paya (${e.name}). IAM user ko s3:ListBucket chahiye. Migration par asar nahi.`);
    }

    await mongoose.disconnect();
    if (counts.failed) process.exit(1);
})().catch(async (e) => {
    console.error("Failed:", e.message);
    await mongoose.disconnect();
    process.exit(1);
});
