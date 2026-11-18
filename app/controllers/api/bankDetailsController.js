const Coach = require("../../models/Coach");
const { ROLES } = require("../../helpers/constants");
const { isValidId } = require("../../helpers/common");
const { encrypt, decrypt, mask } = require("../../helpers/secretBox");

// Coach ki bank details (salary ke liye). DB mein store hoti hain (Form 101 ke ulat).
//   GET /user/coaches/:id/bank-details   coach (sirf apni), club admin (apne club ka coach), super admin
//   PUT /user/coaches/:id/bank-details   same log
// accountNumber encrypted (secretBox / PAYMENT_ENCRYPTION_KEY). req.body kabhi log nahi karte.
// NOTE: live se pehle HTTPS zaroori hai, warna details network pe plain jaati hain.

const sendError = (res, status, message, data = {}) =>
    res.status(status).json({ error: true, status, message, message_desc: message, data });

const sendOk = (res, message, data = {}) => res.status(200).json({ error: false, status: 200, message, message_desc: message, data });

const sendServerError = (res, label, e) => {
    console.error(`${label} error:`, e?.message || e);
    return res.status(500).json({ error: true, status: 500, message: "Something went wrong.", message_desc: "Something went wrong.", data: {} });
};

// Coach: sirf apna record (dusre coach ka nahi, chahe same club ho). Club admin: apne club ka. Super admin: sab.
const findCoachForBank = async (req, id) => {
    if (!isValidId(id)) return { status: 400, message: "Invalid coach id." };

    const coach = await Coach.findById(id).select("+bankDetails");
    if (!coach) return { status: 404, message: "Coach not found." };

    const { role } = req.user;
    const allowed =
        role === ROLES.SUPER_ADMIN ||
        (role === ROLES.CLUB_ADMIN && String(req.clubId) === String(coach.clubId)) ||
        (role === ROLES.COACH && String(coach.userId) === String(req.user._id));

    if (!allowed) return { status: 404, message: "Coach not found." };
    return { coach };
};

const formatBankDetails = (bank) => {
    if (!bank) return null;

    let accountNumber = "";
    let needsReentry = false;
    try {
        accountNumber = decrypt(bank.accountNumber);
    } catch (e) {
        needsReentry = true; // encryption key badal gayi: dobara bharna padega
    }

    return {
        bankCode: bank.bankCode,
        branch: bank.branch,
        accountNumber,
        accountNumberMasked: mask(accountNumber),
        accountHolder: bank.accountHolder || "",
        updatedAt: bank.updatedAt,
        updatedBy: bank.updatedBy,
        ...(needsReentry ? { needsReentry: true } : {}),
    };
};

const digitsOnly = (value) => String(value ?? "").replace(/[\s-]/g, "");

/** GET /user/coaches/:id/bank-details   -> data.bankDetails = null agar abhi bhari nahi */
const getBankDetails = async (req, res) => {
    try {
        const { coach, status, message } = await findCoachForBank(req, req.params.id);
        if (!coach) return sendError(res, status, message);
        return sendOk(res, "Bank details fetched.", { bankDetails: formatBankDetails(coach.bankDetails) });
    } catch (e) {
        return sendServerError(res, "getBankDetails", e);
    }
};

/**
 * PUT /user/coaches/:id/bank-details
 * body: { bankCode: "12", branch: "345", accountNumber: "123456", accountHolder?: "Yonatan Almog" }
 * Poora record replace hota hai (saare required fields har baar).
 */
const updateBankDetails = async (req, res) => {
    try {
        const { coach, status, message } = await findCoachForBank(req, req.params.id);
        if (!coach) return sendError(res, status, message);

        const body = req.body || {};
        const bankCode = digitsOnly(body.bankCode);
        const branch = digitsOnly(body.branch);
        const accountNumber = digitsOnly(body.accountNumber);
        const accountHolder = String(body.accountHolder ?? "").trim();

        if (!/^\d{1,3}$/.test(bankCode)) return sendError(res, 400, "Bank code must be 1 to 3 digits.");
        if (!/^\d{1,4}$/.test(branch)) return sendError(res, 400, "Branch number must be 1 to 4 digits.");
        if (!/^\d{4,13}$/.test(accountNumber)) return sendError(res, 400, "Account number must be 4 to 13 digits.");
        if (accountHolder.length > 100) return sendError(res, 400, "Account holder name must be 100 characters or fewer.");

        coach.bankDetails = {
            bankCode,
            branch,
            accountNumber: encrypt(accountNumber),
            accountHolder,
            updatedAt: new Date(),
            updatedBy: req.user._id,
        };
        await coach.save();

        return sendOk(res, "Bank details saved.", { bankDetails: formatBankDetails(coach.bankDetails) });
    } catch (e) {
        return sendServerError(res, "updateBankDetails", e);
    }
};

module.exports = { getBankDetails, updateBankDetails };
