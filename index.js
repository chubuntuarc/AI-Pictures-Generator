// --- Imports ---
const express = require("express");
const axios = require("axios");
// --- REMOVED Google Sheets Imports ---
// const { GoogleSpreadsheet } = require("google-spreadsheet");
// const { JWT } = require("google-auth-library"); // Or use GoogleAuth for ADC
// const { GoogleAuth } = require("google-auth-library");
const dotenv = require("dotenv");
const path = require("path");
// --- ADDED CSV Imports ---
const fs = require("fs");
const csv = require("csv-parser");
// --- ADDED: Multer for file uploads ---
const multer = require("multer");

// --- Load Environment Variables ---
dotenv.config();

// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 3000; // Use environment port or default to 3000

// --- Middleware ---
app.use(express.urlencoded({ extended: true })); // For parsing form data
app.use(express.json()); // *** ADDED: For parsing JSON bodies (needed for /generate-images-from-list if we used fetch) ***
// --- Note: express.json() isn't strictly needed for the current /generate-images which uses urlencoded form data, but good to have ---
app.set("view engine", "ejs"); // Set EJS as the templating engine
app.set("views", path.join(__dirname, "views")); // Tell Express where to find view templates

// --- Multer Configuration ---
// Configure multer to store uploaded files temporarily in an 'uploads/' directory
// You might want to add 'uploads/' to your .gitignore file
const upload = multer({ dest: "uploads/" });

// --- Configuration ---
const MODEL = "gpt-image-1"; // Or "dall-e-2"
const N = 1; // Generate one image per prompt
const SIZE = "1024x1024";
const API_URL = "https://api.openai.com/v1/images/generations";
const REQUEST_TIMEOUT = 60000; // Timeout for API requests in milliseconds
// Note: Axios timeout includes connection and response time

// --- CSV File Configuration ---
// const PROMPT_CSV_PATH = process.env.PROMPT_CSV_PATH || "prompts.csv"; // Default to prompts.csv in the root
const PROMPT_CSV_COLUMN_INDEX = parseInt(
  process.env.PROMPT_CSV_COLUMN_INDEX || "0",
  10
); // Column A (0-based index)

// --- REMOVED Google Sheet Configuration ---
// const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
// const SHEET_NAME = "Prompts"; // Or the name of your specific sheet/tab
// const PROMPT_COLUMN_INDEX = 0; // Column A (0-based index in google-spreadsheet)

// --- REMOVED Helper Function for Google Sheets ---
// async function getPromptsFromSheet() { ... }

// --- NEW Helper Function for CSV ---
async function getPromptsFromCSV(filePath, columnIndex) {
  return new Promise((resolve) => {
    const prompts = [];
    let header = null; // To store the header row

    if (!fs.existsSync(filePath)) {
      console.error(`Error: CSV file not found at path: ${filePath}`);
      return resolve({
        success: false,
        error: `CSV file not found at '${filePath}'. Please ensure the file exists and the PROMPT_CSV_PATH environment variable is set correctly.`,
      });
    }

    fs.createReadStream(filePath)
      .pipe(csv({ headers: false })) // Treat first row as data initially
      .on("headers", (headers) => {
        // Capture the actual header row if needed for validation later
        header = headers;
        if (columnIndex >= header.length) {
          // Stop processing if the index is out of bounds
          console.error(
            `Error: PROMPT_CSV_COLUMN_INDEX (${columnIndex}) is out of bounds for the CSV file (columns: ${header.length}).`
          );
          // Destroy the stream to prevent further processing
          this.destroy(
            new Error(
              `Prompt column index ${columnIndex} is invalid for the CSV file.`
            )
          );
        }
      })
      .on("data", (row) => {
        // 'row' is an array because headers: false
        if (row && row[columnIndex] !== undefined) {
          const prompt = String(row[columnIndex]).trim();
          if (prompt) {
            // Only add non-empty prompts
            prompts.push(prompt);
          }
        }
      })
      .on("end", () => {
        if (prompts.length === 0 && header && columnIndex >= header.length) {
          // Error already handled in 'headers' event, resolve with failure
          // This prevents sending a success=false with "No prompts found" when the real issue is the index
          // Note: The promise might have already resolved due to this.destroy() in 'headers'
          // We add a check here for robustness but the primary handling is above.
          // If the stream wasn't destroyed, resolve with the specific index error.
          resolve({
            success: false,
            error: `Invalid column index (${columnIndex}). The CSV file has fewer columns.`,
          });
        } else if (prompts.length === 0) {
          console.warn(
            `No prompts found in column ${columnIndex} of CSV file: ${filePath}`
          );
          // It might not be an error if the file is empty, but we should inform the user.
          resolve({
            success: false,
            error: `No prompts found in column ${
              columnIndex + 1
            } of the CSV file '${path.basename(filePath)}'.`, // Show only filename
          });
        } else {
          console.log(
            `Successfully loaded ${prompts.length} prompts from ${filePath}`
          );
          resolve({ success: true, prompts: prompts });
        }
      })
      .on("error", (error) => {
        console.error(`Error reading or parsing CSV file: ${filePath}`, error);
        // Handle specific errors like the index out of bounds error
        if (
          error.message.includes("Prompt column index") ||
          error.message.includes("out of bounds")
        ) {
          resolve({
            success: false,
            error: `Invalid column index (${columnIndex}). The CSV file has fewer columns.`,
            details: error.message,
          });
        } else {
          resolve({
            success: false,
            error: "Failed to read or parse the CSV file.",
            details: error.message,
          });
        }
      });
  });
}

// --- Helper Function for API Call ---
async function generateImage(prompt, apiKey) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const payload = {
    model: MODEL,
    prompt: prompt,
    n: N,
    size: SIZE,
  };

  try {
    const response = await axios.post(API_URL, payload, {
      headers: headers,
      timeout: REQUEST_TIMEOUT,
    });

    // Check if response.data and the nested structure exist
    if (
      response.data &&
      response.data.data &&
      response.data.data.length > 0 &&
      response.data.data[0].b64_json
    ) {
      const b64_json_data = response.data.data[0].b64_json;
      return { success: true, b64_json: b64_json_data };
    } else {
      const error_message = "Could not extract b64_json from API response.";
      console.error(`Error: ${error_message}`);
      console.error(`API Response Data: ${JSON.stringify(response.data)}`);
      return {
        success: false,
        error: error_message,
        details: JSON.stringify(response.data),
      };
    }
  } catch (error) {
    let errorMessage = "An unexpected error occurred during image generation.";
    let errorDetails = error.message; // Default details

    if (error.code === "ECONNABORTED" || error.message.includes("timeout")) {
      errorMessage = "API request timed out.";
      console.error(`Error: ${errorMessage}`);
    } else if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      errorMessage = `API request failed with status ${error.response.status}.`;
      errorDetails = JSON.stringify(error.response.data); // Get specific error from OpenAI
      console.error(`Error: ${errorMessage}`);
      console.error(`API Error Response: ${errorDetails}`);
    } else if (error.request) {
      // The request was made but no response was received
      errorMessage = "API request failed: No response received from server.";
      console.error(`Error: ${errorMessage}`);
      console.error(`Request details: ${error.request}`);
    } else {
      // Something happened in setting up the request that triggered an Error
      errorMessage = `API request setup failed: ${error.message}`;
      console.error(`Error: ${errorMessage}`);
    }
    // Add check for specific parsing errors if needed, though axios usually handles JSON parsing
    return { success: false, error: errorMessage, details: errorDetails };
  }
}

// --- Express Routes ---

app.get("/", (req, res) => {
  // Pass the expected column index to the view for information
  res.render("index", {
    error: null,
    promptColumnIndex: PROMPT_CSV_COLUMN_INDEX + 1, // Display 1-based index
  });
});

// --- REMOVED: Route for loading prompts from Google Sheets ---
// app.get("/load_prompts", async (req, res) => { ... });

app.post(
  "/load-prompts-from-file",
  upload.single("promptFile"),
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No CSV file was uploaded." });
    }

    const uploadedFilePath = req.file.path;
    console.log(
      `Attempting to load prompts from uploaded CSV: ${uploadedFilePath}, column index: ${PROMPT_CSV_COLUMN_INDEX}`
    );

    const promptResult = await getPromptsFromCSV(
      uploadedFilePath,
      PROMPT_CSV_COLUMN_INDEX
    );

    // Clean up the uploaded file
    fs.unlink(uploadedFilePath, (err) => {
      if (err)
        console.error(
          `Error deleting temporary file ${uploadedFilePath}:`,
          err
        );
      else console.log(`Deleted temporary file: ${uploadedFilePath}`);
    });

    if (!promptResult.success) {
      console.error(`Failed to load prompts from CSV: ${promptResult.error}`);
      // Return error as JSON
      return res
        .status(400)
        .json({ success: false, error: promptResult.error });
    }

    // Return success and prompts as JSON
    res.json({ success: true, prompts: promptResult.prompts });
  }
);

app.post("/generate-images", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    // Render results page with a server configuration error
    return res.render("results", {
      // Assuming you have a results.ejs view
      results: [],
      error: "Server configuration error: API key not set.",
    });
  }

  let prompts = [];
  try {
    // Prompts are sent as a JSON string in the form field 'promptsJson'
    if (req.body.promptsJson) {
      prompts = JSON.parse(req.body.promptsJson);
    }
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error("Invalid or empty prompts data received.");
    }
  } catch (parseError) {
    console.error("Error parsing prompts JSON:", parseError);
    return res.render("results", {
      results: [],
      error:
        "Failed to process prompts data. Please try loading the file again.",
    });
  }

  const resultsList = [];
  console.log(`Generating images for ${prompts.length} prompts...`);

  // Process prompts sequentially
  for (const prompt of prompts) {
    console.log(`Generating image for prompt: '${prompt}'`);
    const result = await generateImage(prompt, apiKey);
    const generationInfo = { prompt: prompt }; // Store prompt with its result

    if (result.success) {
      console.log(`  Success for prompt: '${prompt}'`);
      generationInfo.image_data_uri = `data:image/png;base64,${result.b64_json}`;
    } else {
      console.error(`  Failed for prompt: '${prompt}'. Error: ${result.error}`);
      generationInfo.error = result.error;
      generationInfo.error_details = result.details; // Include details if available
    }
    resultsList.push(generationInfo);
  }

  console.log("Finished generating all images.");
  // Render the results page (assuming you have results.ejs)
  res.render("results", { results: resultsList, error: null });
});

// --- Run the App ---
// Check for environment variables at startup
const apiKey = process.env.OPENAI_API_KEY;
// --- REMOVED: Check for CSV Path ---
// const csvPath = PROMPT_CSV_PATH;

let startupOk = true;
if (!apiKey) {
  console.error("CRITICAL: OPENAI_API_KEY environment variable is not set.");
  startupOk = false;
}
// --- REMOVED: Check if the CSV file exists ---
// if (!csvPath) { ... } else if (!fs.existsSync(csvPath)) { ... }

if (!startupOk) {
  console.error(
    "\nPlease set the required environment variables (e.g., in a .env file)."
  );
  process.exit(1); // Exit if critical variables are missing
} else {
  console.log("OpenAI API Key found.");
  // --- UPDATED: Log column index info ---
  console.log(
    `Expecting prompts in column index: ${PROMPT_CSV_COLUMN_INDEX} (0-based) of the uploaded CSV.`
  );
}

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
