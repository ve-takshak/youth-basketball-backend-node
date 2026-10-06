require("dotenv").config(); // sabse upar, taaki database.js ko MONGODB_URI mil jaye

const express = require("express");
const cors = require("cors");
const path = require("path");
const router = require("./routes/api.js");

const app = express();

// Serve static uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Kaun se frontend is API ko call kar sakte hain
const allowedOrigins = [
    "http://localhost:3000",
    "https://youth-basketball-backend-bfjf37gfh-ve-4d94.vercel.app",
    "http://13.63.166.225"
];


const vercelProjectPattern = /^https:\/\/youth-basketball-backend[a-z0-9-]*\.vercel\.app$/;
const localhostPattern = /^http:\/\/localhost:[0-9]+$/;

app.use(cors({
    origin: (origin, callback) => {
        // Postman / server-to-server calls mein origin nahi hota, unhe allow karo
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || vercelProjectPattern.test(origin) || localhostPattern.test(origin)) {
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

app.get("/", (req, res) => res.send("Hello from Node.js!"));

app.use("/api", router);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));