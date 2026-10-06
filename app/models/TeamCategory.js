const mongoose = require("../../config/database");

const TeamCategorySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            trim: true,
            required: [true, "Category name is required"],
        },
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
