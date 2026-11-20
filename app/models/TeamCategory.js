const mongoose = require("../../config/database");

// Team category = age group (U12 Minis, U14 Boys...). Team, fee plan aur player teeno yahi id use karte hain.
// maxAge + gender se player ka age group date of birth se apne aap nikalta hai (helpers/ageGroup):
//   maxAge  "U14" = 14 (season shuru 1 Aug ko umar 14 se kam). null = birth date se kabhi nahi chunti. Senior = 99.
//   gender  "boys" | "girls" | "" (sabke liye)
const CATEGORY_GENDERS = ["", "boys", "girls"];

const TeamCategorySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            trim: true,
            required: [true, "Category name is required"],
        },
        maxAge: { type: Number, min: 1, max: 99, default: null },
        gender: { type: String, enum: CATEGORY_GENDERS, default: "" },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
    },
    { timestamps: true }
);

TeamCategorySchema.index({ name: 1 });

const TeamCategory = mongoose.model("TeamCategory", TeamCategorySchema);
module.exports = TeamCategory;
module.exports.CATEGORY_GENDERS = CATEGORY_GENDERS;
