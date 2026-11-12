const crypto = require("crypto");
const mongoose = require("../../config/database");

// Ek player ka ek bill (invoice): season registration + jersey waghera.
// Parent mobile app se pay karta hai (gateway ka hosted page) ya admin cash / bank transfer mark karta hai.
//
// status DB mein:  unpaid | pending | paid | failed | refunded | cancelled
// App ka badge (Paid / Unpaid / Overdue / Pending) helpers/paymentStatus.js se nikalta hai:
//   overdue = unpaid + dueDate nikal gayi. pending = checkout shuru hua, abhi result nahi aaya.
//
// Do tarah se pay:
//   plan "one_time"        -> poora amount ek baar mein
//   plan "standing_order"  -> jersey jaise "upfront" items pehli kisht ke saath, season fee har mahine
//                             (Tranzila My Billing STO, token terminal pe). sto.* Tranzila se sync hota hai.
const CHARGE_ITEM_TYPES = ["season_registration", "jersey", "other"];
// Ye items Standing Order mein bhi pehli payment mein hi poore katte hain (kisht mein nahi bant-te)
const UPFRONT_ITEM_TYPES = ["jersey"];
const CHARGE_STATUSES = ["unpaid", "pending", "paid", "failed", "refunded", "cancelled"];
const PAYMENT_PLANS = ["one_time", "standing_order"];
const PAYMENT_METHODS = ["card", "saved_card", "standing_order", "cash", "bank_transfer", "check", "other", ""];
const CURRENCIES = ["ILS", "USD", "EUR"];

const ChargeItemSchema = new mongoose.Schema(
    {
        type: { type: String, enum: CHARGE_ITEM_TYPES, default: "other" },
        name: { type: String, trim: true, required: true },
        amount: { type: Number, min: 0, required: true },
    },
    { _id: true }
);

// Standing Order (Tranzila STO) ki details. Tranzila hi har mahine charge karta hai, hum sirf dikhate hain.
const StandingOrderSchema = new mongoose.Schema(
    {
        installments: { type: Number, min: 1, default: 1 }, // kul kitni kisht (pehli wali mila ke)
        firstAmount: { type: Number, min: 0, default: 0 }, // pehli kisht = mahine ki kisht + upfront items
        monthlyAmount: { type: Number, min: 0, default: 0 }, // baaki har mahine
        firstChargeDate: { type: Date, default: null }, // pehli kisht (aaj)
        recurStartDate: { type: Date, default: null }, // doosri kisht ki date

        // Tranzila se (sto/get)
        stoId: { type: String, default: "" },
        terminal: { type: String, default: "" },
        stoStatus: { type: String, default: "" }, // active | inactive
        lastChargeDate: { type: Date, default: null },
        nextChargeDate: { type: Date, default: null },
        syncedAt: { type: Date, default: null },
    },
    { _id: false }
);

const RefundSchema = new mongoose.Schema(
    {
        amount: { type: Number, min: 0, required: true },
        reason: { type: String, trim: true, default: "" },
        providerTxnId: { type: String, default: "" },
        manual: { type: Boolean, default: false }, // gateway ke bahar (My Tranzila / cash) diya
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    { _id: false }
);

// Gateway se aayi har koshish ka log (debug / dispute ke liye). Card number kabhi nahi.
const ChargeEventSchema = new mongoose.Schema(
    {
        kind: { type: String, default: "" }, // checkout | webhook | charge | refund | manual
        success: { type: Boolean, default: null },
        message: { type: String, default: "" },
        raw: { type: mongoose.Schema.Types.Mixed, default: {} },
        at: { type: Date, default: Date.now },
    },
    { _id: false }
);

const ChargeSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
        season: { type: String, trim: true, default: "" },
        feePlanId: { type: mongoose.Schema.Types.ObjectId, ref: "FeePlan", default: null }, // kis price plan se bana (khaali = haath se items)
        customAmount: { type: Boolean, default: false }, // is player ki fee plan se alag rakhi gayi

        invoiceNumber: { type: String, unique: true },
        title: { type: String, trim: true, default: "" }, // "Season registration 2026 / 2027"
        items: { type: [ChargeItemSchema], validate: (v) => v.length > 0 },
        amount: { type: Number, min: 0, required: true }, // items ka total
        currency: { type: String, enum: CURRENCIES, default: "ILS" },
        dueDate: { type: Date, default: null },

        status: { type: String, enum: CHARGE_STATUSES, default: "unpaid" },
        checkoutStartedAt: { type: Date, default: null },
        plan: { type: String, enum: PAYMENT_PLANS, default: "one_time" },
        // Checkout ke waqt parent ne jo chuna (webhook isi se samjhta hai). Payment ke baad "plan" mein copy.
        pendingPlan: { type: String, enum: [...PAYMENT_PLANS, ""], default: "" },
        standingOrder: { type: StandingOrderSchema, default: null },

        // Tranzila receipt (RE) - "Download receipt" button
        receipt: {
            documentId: { type: String, default: "" },
            number: { type: String, default: "" },
            retrievalKey: { type: String, default: "", select: false },
        },

        // Coach / admin reminder (ek din mein ek baar)
        lastReminderAt: { type: Date, default: null },
        reminderCount: { type: Number, default: 0 },

        // Payment ho jaane ke baad
        paidAt: { type: Date, default: null },
        paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // parent / admin
        method: { type: String, enum: PAYMENT_METHODS, default: "" },
        provider: { type: String, default: "" },
        providerTxnId: { type: String, default: "" },
        authNumber: { type: String, default: "" },
        card: {
            last4: { type: String, default: "" },
            brand: { type: String, default: "" },
        },
        // Refund ke liye gateway token (encrypted) + expiry. select:false, API mein nahi jaata.
        paymentToken: { type: String, default: "", select: false },
        tokenExpMonth: { type: Number, default: null, select: false },
        tokenExpYear: { type: Number, default: null, select: false },

        refundedAmount: { type: Number, min: 0, default: 0 },
        refunds: { type: [RefundSchema], default: [] },
        events: { type: [ChargeEventSchema], default: [], select: false },

        notes: { type: String, trim: true, maxlength: 500, default: "" },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

ChargeSchema.index({ clubId: 1, season: 1, status: 1 });
ChargeSchema.index({ playerId: 1, season: 1 });
ChargeSchema.index({ feePlanId: 1 });

// INV2026-7KQ9M2X4
ChargeSchema.pre("validate", async function () {
    if (!this.isNew || this.invoiceNumber) return;
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = `INV${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        if (!(await this.constructor.exists({ invoiceNumber: code }))) {
            this.invoiceNumber = code;
            return;
        }
    }
    throw new Error("Could not generate a unique invoice number.");
});

const Charge = mongoose.model("Charge", ChargeSchema);
module.exports = Charge;
module.exports.CHARGE_ITEM_TYPES = CHARGE_ITEM_TYPES;
module.exports.UPFRONT_ITEM_TYPES = UPFRONT_ITEM_TYPES;
module.exports.PAYMENT_PLANS = PAYMENT_PLANS;
module.exports.CHARGE_STATUSES = CHARGE_STATUSES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
module.exports.CURRENCIES = CURRENCIES;
