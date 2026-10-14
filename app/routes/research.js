const ResearchDAO = require("../data/research-dao").ResearchDAO;
const needle = require("needle");
const {
    environmentalScripts
} = require("../../config/config");

// Allowlist of permitted upstream base URLs for research lookups.
const ALLOWED_RESEARCH_URLS = [
    "https://www.bloomberg.com/markets/quote/",
    "https://finance.yahoo.com/quote/"
];

// Only allow conservative stock-symbol characters.
const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,10}$/;

function ResearchHandler(db) {
    "use strict";

    const researchDAO = new ResearchDAO(db);

    this.displayResearch = (req, res) => {

        if (req.query.symbol) {
            const baseUrl = req.query.url;
            const symbol = req.query.symbol;

            if (typeof baseUrl !== "string" || ALLOWED_RESEARCH_URLS.indexOf(baseUrl) === -1) {
                res.status(400);
                return res.end("Invalid research URL.");
            }
            if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
                res.status(400);
                return res.end("Invalid symbol.");
            }

            const url = baseUrl + encodeURIComponent(symbol);
            return needle.get(url, (error, newResponse, body) => {
                if (!error && newResponse.statusCode === 200) {
                    res.writeHead(200, {
                        "Content-Type": "text/html"
                    });
                }
                res.write("<h1>The following is the stock information you requested.</h1>\n\n");
                res.write("\n\n");
                if (body) {
                    res.write(body);
                }
                return res.end();
            });
        }

        return res.render("research", {
            environmentalScripts
        });
    };

}

module.exports = ResearchHandler;
