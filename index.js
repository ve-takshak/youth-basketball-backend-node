require("dotenv").config(); // sabse upar, taaki database.js ko MONGODB_URI mil jaye

const express = require("express");
const cors = require("cors");
const path = require("path");
const fileUpload = require("express-fileupload");
const router = require("./routes/api.js");

const app = express();

// Purane local logos ke liye (jo S3 se pehle upload hue the)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Kaun se frontend is API ko call kar sakte hain
const allowedOrigins = [
    "http://13.63.166.225", "http://51.17.184.245"
];

// Local development: koi bhi localhost port (3000, 3001...)
const localhostPattern = /^http:\/\/localhost:[0-9]+$/;

app.use(cors({
    origin: (origin, callback) => {
        // Postman / server-to-server calls mein origin nahi hota, unhe allow karo
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || localhostPattern.test(origin)) {
            return callback(null, true);
        }
        console.warn(`CORS blocked: ${origin}`);
        return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// form-data (files + text fields) padhne ke liye: req.files aur req.body yahi bharta hai
app.use(fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    abortOnLimit: true,
}));

app.get("/", (req, res) => res.send("Hello from Node.js!"));

app.use("/api", router);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));