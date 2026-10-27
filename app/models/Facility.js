const mongoose = require("../../config/database");

// Facility = jahan training / games hote hain (hall, court, gym). Har facility ek club ki.
// Client ke "Add facility" form jaisi fields.
const FACILITY_TYPES = ["indoor_hall", "outdoor_court", "gym_room"];

// Hall manager (contact person). Login nahi karta, isliye User nahi, sirf details.
// Iske email par hall ka weekly timetable jayega.
const HallManagerSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true, default: "" },
        countryCode: { type: String, trim: true, default: "+972" },
        phone: { type: String, trim: true, default: "" },
        email: { type: String, trim: true, lowercase: true, default: "" },
    },
    { _id: false }
);

const FacilitySchema = new mongoose.Schema(
    {
        clubId: { type: mongoose.Schema.Types.ObjectId, ref: "Club", required: true },

        name: { type: String, trim: true, required: true }, // "Main sports hall"
        address: { type: String, trim: true, default: "" }, // courses / registrations pages pe navigation isi se

        type: { type: String, enum: FACILITY_TYPES, default: "indoor_hall" },

        // Ek saath kitne sessions chal sakte hain (2 = half-courts)
        parallelUnits: { type: Number, min: 1, default: 1 },

        hallManager: { type: HallManagerSchema, default: () => ({}) },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // superAdmin ya clubAdmin
    },
    { timestamps: true }
);

// Ek club mein same naam ki do facility nahi (capital / small ek jaisa)
FacilitySchema.index(
    { clubId: 1, name: 1 },
    { unique: true, collation: { locale: "en", strength: 2 } }
);

const Facility = mongoose.model("Facility", FacilitySchema);
module.exports = Facility;
module.exports.FACILITY_TYPES = FACILITY_TYPES;