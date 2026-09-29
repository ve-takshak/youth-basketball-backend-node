const jwt = require("jsonwebtoken")
let User = require("../models/User");
require('dotenv').config()

const authentication = async (req, res, next) => {
    try {
        const token = req.header('Authorization');

        if (!token) {
            return res.status(401).send({
                error: true,
                message: "Token is required.",
                message_desc: "Token is required.",
                data: {},
                auth: {}
            });
        }

        const bearerToken = token.split(" ");

        if (bearerToken[0] === 'Bearer' || bearerToken[0] === 'bearer') {
            let Token = bearerToken.length === 2 ? bearerToken[1] : '';

            if (Token.length === 0) {
                return res.send({
                    error: false,
                    message: "Token is required.",
                    message_desc: "Token is required.",
                    data: {},
                    auth: {}
                });
            }

            jwt.verify(Token, process.env.JWTKEY, async (err, userDetails) => {
                if (err === null) {
                    req.user = userDetails;

                    if (userDetails.login_data._id) {
                        const isUserExist = await User.findOne({ _id: userDetails.login_data._id });

                        if (!isUserExist) {
                            return res.status(401).send({
                                error: true,
                                message: "User no longer exist (Unauthorized).",
                                message_desc: "Unauthorized",
                                data: {},
                                auth: {}
                            });
                        }
                

                        if (isUserExist.is_verify == 0 && isUserExist.signup_type == 'Normal') {
                            return res.send({
                                error: true,
                                message: "Please verify your account.",
                                message_desc: "Please verify your account.",
                                data: {},
                                auth: {}
                            });
                        }
                    }

                    next();
                } else {
                    return res.status(401).send({
                        error: true,
                        message: "Unauthorized." + err,
                        message_desc: "Unauthorized",
                        data: {},
                        auth: {}
                    });
                }
            });

        } else {
            return res.status(401).send({
                error: true,
                message: "Invalid authorization type (Unauthorized).",
                message_desc: "Unauthorized",
                data: {},
                auth: {}
            });
        }

    } catch (e) {
        return res.status(401).send({
            error: true,
            message: "Unauthenticated.",
            message_desc: "Unauthorized",
            data: {},
            auth: {}
        });
    }
}


module.exports = { authentication }