const { isBucketUrl, signBucketUrl } = require("../../utils/s3");

// Bucket private hai, isliye plain S3 URL (profile_image, club logo...) browser mein 403 deta hai.
// Ye middleware har API response bhejne se pehle usme jitne bhi hamare bucket ke plain URL hain,
// unhe signed URL (1-2 ghante) se badal deta hai. Field ka naam kuch bhi ho, sab cover.
// Frontend / mobile app ko kuch nahi badalna: unhe pehle jaisa URL milta hai, bas signed.
// DB mein plain URL hi rehta hai (delete wagairah ke liye), sirf response badalta hai.

// Response mein jitne bucket URL hain, sab ek baar mein sign karke wapas daalna
const signAll = async (data) => {
    const found = new Set();
    const collect = (node) => {
        if (Array.isArray(node)) node.forEach(collect);
        else if (node && typeof node === "object") Object.values(node).forEach(collect);
        else if (isBucketUrl(node)) found.add(node);
    };
    collect(data);
    if (found.size === 0) return data;

    const signed = new Map();
    await Promise.all([...found].map(async (url) => signed.set(url, await signBucketUrl(url))));

    const replace = (node) => {
        if (Array.isArray(node)) return node.map(replace);
        if (node && typeof node === "object") {
            for (const key of Object.keys(node)) node[key] = replace(node[key]);
            return node;
        }
        return signed.get(node) || node;
    };
    return replace(data);
};

const signS3Urls = (req, res, next) => {
    const sendJson = res.json.bind(res);

    res.json = (body) => {
        // Mongoose documents wagairah ko plain JSON mein badalna. Bucket URL hi nahi toh seedha bhejo.
        let text;
        try {
            text = JSON.stringify(body);
        } catch (e) {
            return sendJson(body);
        }
        if (!text || !text.includes(".amazonaws.com/")) return sendJson(body);

        const data = JSON.parse(text);
        signAll(data)
            .then((result) => sendJson(result))
            .catch((err) => {
                console.error("Signing S3 URLs failed:", err.message);
                sendJson(data);
            });
        return res;
    };

    next();
};

module.exports = signS3Urls;
