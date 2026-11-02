const ClubTerms = require("../models/ClubTerms");
const TermsAcceptance = require("../models/TermsAcceptance");

// "Required" version: sabse naya version jisme requireReaccept true hai (pehla version hamesha true).
// Parent ne uske baad ka (ya wahi) koi bhi version accept kiya ho toh theek hai.
// Club ke terms hi na hon toh null: kisi ko rokna nahi.
const getRequiredTerms = (clubId) =>
    ClubTerms.findOne({ clubId, requireReaccept: true }).sort({ version: -1 }).select("_id version");

const hasAcceptedRequired = async (userId, clubId, required) =>
    Boolean(await TermsAcceptance.exists({ userId, clubId, version: { $gte: required.version } }));

module.exports = { getRequiredTerms, hasAcceptedRequired };
