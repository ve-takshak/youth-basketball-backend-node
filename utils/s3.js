const crypto = require('crypto');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');


const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Private files (ID / passport scans) is folder mein. DB mein sirf key save hoti hai, URL nahi.
const PRIVATE_DOC_FOLDER = 'id-documents';
// Signed URL kitni der chalega (seconds)
const SIGNED_URL_TTL = 5 * 60;

const bucketBaseUrl = () =>
    `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/`;

// Har file KMS key se encrypt (bucket ka default bhi KMS hai, yahan explicit taaki galti se bina KMS na jaye)
const kmsParams = () => (
    process.env.S3_KMS_KEY_ID
        ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: process.env.S3_KMS_KEY_ID, BucketKeyEnabled: true }
        : { ServerSideEncryption: 'aws:kms' }
);

// File ka naam: random UUID + extension (timestamp jaisa guess nahi ho sakta)
const randomKey = (folder, file) => {
    const ext = path.extname(file.name || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    return `${folder}/${crypto.randomUUID()}${ext}`;
};

const putFile = async (key, file) => {
    await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: Buffer.from(file.data, 'binary'),
        ContentType: file.mimetype,
        ...kmsParams(),
    }));
};


/**
 * Public type files (club logo, profile photo). Poora URL return karta hai.
 */
let upload_files = async (folder, files) => {
    if (!files) return '';
    const key = randomKey(folder, files);
    try {
        await putFile(key, files);
        return `${bucketBaseUrl()}${key}`;
    } catch (e) {
        console.log("Error uploading data: ", e);
        return '';
    }
}


/**
 * Private file (ID / passport). Sirf S3 key return karta hai, jaise "id-documents/<uuid>.pdf".
 * Ise kabhi seedha frontend ko mat bhejo, getSignedFileUrl se dikhao.
 */
const uploadPrivateFile = async (file) => {
    if (!file) return '';
    const key = randomKey(PRIVATE_DOC_FOLDER, file);
    try {
        await putFile(key, file);
        return key;
    } catch (e) {
        console.log("Error uploading private file: ", e);
        return '';
    }
};

// DB value se S3 key: nayi value pehle se key hai, purani value poora bucket URL hai
const keyFromStored = (value) => {
    if (!value) return '';
    const base = bucketBaseUrl();
    if (value.startsWith(base)) return value.slice(base.length);
    if (value.startsWith(`${PRIVATE_DOC_FOLDER}/`)) return value;
    return '';
};

const isS3Stored = (value) => Boolean(keyFromStored(value));

/**
 * Thodi der ka signed URL (default 5 min). Role check is function ko call karne se PEHLE karo.
 */
const getSignedFileUrl = async (value, { expiresIn = SIGNED_URL_TTL, downloadName } = {}) => {
    const key = keyFromStored(value);
    if (!key) return '';
    const name = downloadName || `document${path.extname(key)}`;
    return getSignedUrl(
        s3,
        new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            ResponseContentDisposition: `inline; filename="${name}"`,
            ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn }
    );
};


// ---------------------------------------------------------------------------
// Photos / logos (bucket private hone ke baad): API response mein plain URL ki jagah signed URL.
// Signature ghante ki shuruaat (signingDate) se banta hai, isliye ek ghante tak URL same rehta hai
// aur browser / app image cache kar paate hain. Har URL kam se kam 1 ghanta, zyada se zyada 2 ghante chalta hai.
// ---------------------------------------------------------------------------
const IMAGE_URL_TTL = 2 * 60 * 60;
const SIGN_WINDOW_MS = 60 * 60 * 1000;
let signCache = new Map();
let signCacheWindow = 0;

const isBucketUrl = (value) =>
    typeof value === 'string' && value.startsWith(bucketBaseUrl()) && !value.includes('?');

const signBucketUrl = async (url) => {
    const windowStart = Math.floor(Date.now() / SIGN_WINDOW_MS) * SIGN_WINDOW_MS;
    if (windowStart !== signCacheWindow) {
        signCache = new Map();
        signCacheWindow = windowStart;
    }
    if (signCache.has(url)) return signCache.get(url);

    const signed = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: url.slice(bucketBaseUrl().length) }),
        { expiresIn: IMAGE_URL_TTL, signingDate: new Date(windowStart) }
    );
    signCache.set(url, signed);
    return signed;
};


const deleteFiles = async (folder, fileName) => {
    const params = {
        Bucket: process.env.S3_BUCKET,
        Key: folder + "/" + fileName
    };
    try {
        await s3.send(new DeleteObjectCommand(params));
        return 1
    } catch (e) {
        return e;
    }
}

// Key ya purana URL, dono se delete
const deleteStoredFile = async (value) => {
    const key = keyFromStored(value);
    if (!key) return 0;
    try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
        return 1;
    } catch (e) {
        return e;
    }
};


module.exports = {
    upload_files,
    deleteFiles,
    uploadPrivateFile,
    getSignedFileUrl,
    deleteStoredFile,
    isS3Stored,
    SIGNED_URL_TTL,
    isBucketUrl,
    signBucketUrl,
}
