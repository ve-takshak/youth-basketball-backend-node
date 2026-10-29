const mongoose = require("../../config/database");

// Private notes: coach ke baare mein (coach notes) ya player ke baare mein (player notes).
// Parents / players ko kabhi nahi dikhte. Rules controller mein hain.
const NOTE_TYPES = ["coach", "player"];
const NOTE_MAX_LENGTH = 2000;

const NoteSchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },
        type: { type: String, enum: NOTE_TYPES, required: true },

        // Kiske baare mein: type "coach" ho toh coachId, "player" ho toh playerId
        coachId: { type: mongoose.Schema.Types.ObjectId, ref: "Coach", default: null },
        playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", default: null },

        text: { type: String, trim: true, required: true, maxlength: NOTE_MAX_LENGTH },

        // Kisne likha (superAdmin / clubAdmin / coach)
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        createdByRole: { type: String, required: true },
    },
    { timestamps: true }
);

NoteSchema.index({ clubId: 1, type: 1, createdAt: -1 });
NoteSchema.index({ coachId: 1, createdAt: -1 });
NoteSchema.index({ playerId: 1, createdAt: -1 });

const Note = mongoose.model("Note", NoteSchema);
module.exports = Note;
module.exports.NOTE_TYPES = NOTE_TYPES;
module.exports.NOTE_MAX_LENGTH = NOTE_MAX_LENGTH;