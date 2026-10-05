const mongoose = require("../../config/database");

const ClubSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true, required: true },

      
        logo: { type: String, default: "" },

       
        theme: {
            primary: { type: String, default: "#1E40AF" },
            secondary: { type: String, default: "#F59E0B" },
            background: { type: String, default: "#FFFFFF" },
        },

        
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

const Club = mongoose.model("Club", ClubSchema);
module.exports = Club;