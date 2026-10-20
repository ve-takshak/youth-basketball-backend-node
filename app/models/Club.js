const crypto = require("crypto");
const mongoose = require("../../config/database");

// 0, O, 1, I, L hata diye taaki padhne/bolne mein confusion na ho
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const randomPart = (length) =>
    Array.from({ length }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");

const ClubSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true, required: true },

        // Club ka chhota unique code, jaise CLB2026K7MX. Create pe apne aap banta hai.
        clubCode: {
            type: String,
            trim: true,
            uppercase: true,
            unique: true,
            immutable: true, // ek baar bana toh kabhi nahi badlega
        },

        // Logo ka URL / file path
        logo: { type: String, default: "" },

        // Theme colors
        theme: {
            primary: { type: String, default: "#1E40AF" },
            secondary: { type: String, default: "#F59E0B" },
            background: { type: String, default: "#FFFFFF" },
        },

        // Kis super admin ne club banaya
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

// Naya club save hone se pehle code banao. Agar code pehle se kisi club ka hai toh dobara try.
ClubSchema.pre("validate", async function () {
    if (!this.isNew || this.clubCode) return;

    const year = new Date().getFullYear();

    for (let attempt = 0; attempt < 5; attempt++) {
        const code = `CLB${year}${randomPart(4)}`;
        const taken = await this.constructor.exists({ clubCode: code });
        if (!taken) {
            this.clubCode = code;
            return;
        }
    }

    throw new Error("Could not generate a unique club code. Please try again.");
});

const Club = mongoose.model("Club", ClubSchema);
module.exports = Club;