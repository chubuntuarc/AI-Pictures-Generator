// --- Imports ---
const express = require("express");
const axios = require("axios");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library"); // Or use GoogleAuth for ADC
const dotenv = require("dotenv");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

// --- Load Environment Variables ---
dotenv.config();

// --- Express App Setup ---
const app = express();
const port = process.env.PORT || 3000; // Use environment port or default to 3000

// --- Middleware ---
app.use(express.urlencoded({ extended: true })); // For parsing form data
app.use(express.json()); // For parsing JSON bodies (though not strictly needed for this app)
app.set("view engine", "ejs"); // Set EJS as the templating engine
app.set("views", path.join(__dirname, "views")); // Tell Express where to find view templates

// --- Configuration ---
const MODEL = "gpt-image-1"; // Or "dall-e-2"
const N = 1; // Generate one image per prompt
const SIZE = "1024x1024";
const API_URL = "https://api.openai.com/v1/images/generations";
const REQUEST_TIMEOUT = 60000; // Timeout for API requests in milliseconds
// Note: Axios timeout includes connection and response time

// --- Google Sheet Configuration ---
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Prompts"; // Or the name of your specific sheet/tab
const PROMPT_COLUMN_INDEX = 0; // Column A (0-based index in google-spreadsheet)

// --- Helper Function for Google Sheets ---
async function getPromptsFromSheet() {
  if (!GOOGLE_SHEET_ID) {
    return {
      success: false,
      error: "GOOGLE_SHEET_ID environment variable not set.",
    };
  }

  try {
    // --- EDIT: Initialize Google Auth for Vercel/Local ---
    console.log("Initializing Google Auth...");
    let auth;
    // Check if running in Vercel and credentials JSON is provided
    if (process.env.VERCEL === "1" && process.env.GOOGLE_CREDENTIALS_JSON) {
      console.log(
        "Using GOOGLE_CREDENTIALS_JSON from environment variables (Vercel)."
      );
      try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        auth = new GoogleAuth({
          credentials,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
      } catch (parseError) {
        console.error("Error parsing GOOGLE_CREDENTIALS_JSON:", parseError);
        return {
          success: false,
          error: "Failed to parse Google credentials JSON.",
          details: parseError.message,
        };
      }
    } else {
      // Fallback to Application Default Credentials (for local dev or other environments)
      console.log(
        "Using Application Default Credentials (local development or fallback)."
      );
      auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
    }
    console.log("Google Auth initialized.");
    // --- END EDIT ---

    // --- NEW: Log the authenticated user ---
    try {
      const credentials = await auth.getCredentials();
      if (credentials && credentials.client_email) {
        console.log(`Authenticated using email: ${credentials.client_email}`);
      } else {
        console.log(
          "Authenticated, but could not determine specific user email (might be using ADC without a specific service account key)."
        );
      }
    } catch (credError) {
      console.warn(
        `Could not retrieve credential details: ${credError.message}`
      );
    }
    // --- END NEW ---

    // Initialize the sheet - doc ID is the long id in the sheet URL
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, auth); // Pass configured auth instance

    await doc.loadInfo(); // loads document properties and worksheets
    console.log(`Loaded Google Sheet: ${doc.title}`);

    const sheet = doc.sheetsByTitle[SHEET_NAME]; // or use doc.sheetsByIndex[index]
    if (!sheet) {
      const error_message = `Worksheet '${SHEET_NAME}' not found in the spreadsheet.`;
      console.error(`Error: ${error_message}`);
      return { success: false, error: error_message };
    }
    console.log(`Accessing sheet: ${sheet.title}`);

    // Load all cells in the prompt column (A) - adjust range as needed
    // Efficiently loads only the specified column
    await sheet.loadCells({
      // Specify range using A1 notation
      startRowIndex: 1, // Skip header row (index 0)
      endRowIndex: sheet.rowCount,
      startColumnIndex: PROMPT_COLUMN_INDEX,
      endColumnIndex: PROMPT_COLUMN_INDEX + 1,
    });

    const prompts = [];
    for (let i = 1; i < sheet.rowCount; i++) {
      // Start from row 1 (after header)
      const cell = sheet.getCell(i, PROMPT_COLUMN_INDEX);
      if (cell.value) {
        // Check if cell has a value
        prompts.push(String(cell.value).trim());
      }
    }

    const filteredPrompts = prompts.filter((p) => p); // Filter out empty strings after trim

    if (filteredPrompts.length === 0) {
      return {
        success: false,
        error: `No prompts found in column ${
          PROMPT_COLUMN_INDEX + 1
        } of sheet '${SHEET_NAME}'.`,
      };
    }

    return { success: true, prompts: filteredPrompts };
  } catch (error) {
    console.error("--- ERROR ACCESSING GOOGLE SHEET ---");
    console.error(`Error Type: ${error.name}`);
    console.error(`Error Message: ${error.message}`);
    // console.error(`Stack Trace:\n${error.stack}`); // Full stack trace if needed

    let userErrorMessage =
      "An unexpected error occurred while accessing Google Sheets.";
    let detailedLog = `Raw error details: ${error.message}`; // Start with the basic message

    // --- EDIT: Enhanced Error Analysis ---
    if (error.response && error.response.data && error.response.data.error) {
      // Handle specific Google API errors (often nested in error.response.data.error)
      const googleError = error.response.data.error;
      detailedLog = `Google API Error: Status ${googleError.code} - ${
        googleError.message
      }. Details: ${JSON.stringify(googleError.details)}`;
      console.error(`Google API Error Details: ${JSON.stringify(googleError)}`);

      if (googleError.code === 403) {
        if (
          googleError.message.includes("permission denied") ||
          googleError.status === "PERMISSION_DENIED"
        ) {
          userErrorMessage =
            "Permission denied accessing Google Sheet. Ensure the service account or your ADC user has access to the sheet.";
          console.error(
            "Specific Error: Permission Denied. Check sheet sharing settings."
          );
        } else if (
          googleError.message.includes("insufficient authentication scopes")
        ) {
          userErrorMessage =
            "Permission denied due to insufficient API scopes. Check the scopes requested in the code.";
          console.error(
            "Specific Error: Insufficient Scopes. Verify 'scopes' array in GoogleAuth."
          );
        } else if (
          googleError.message.toLowerCase().includes("api is not enabled") ||
          googleError.status === "SERVICE_DISABLED"
        ) {
          userErrorMessage =
            "The Google Sheets API is not enabled for your project. Please enable it in the Google Cloud Console.";
          console.error(
            "Specific Error: Google Sheets API is likely not enabled for this project."
          );
        } else {
          userErrorMessage = `Permission denied accessing Google Sheet (Code 403). Reason: ${googleError.message}`;
          console.error(
            `Specific Error: General 403 Forbidden - ${googleError.message}`
          );
        }
      } else if (googleError.code === 404) {
        userErrorMessage =
          "Google Sheet not found. Verify the GOOGLE_SHEET_ID is correct.";
        console.error(
          "Specific Error: Google Sheet Not Found (404). Check GOOGLE_SHEET_ID."
        );
      } else {
        userErrorMessage = `Google API Error: ${googleError.message} (Code: ${googleError.code})`;
      }
    } else if (error.response) {
      // Handle other HTTP errors (non-Google API specific format)
      detailedLog = `HTTP Error: Status ${
        error.response.status
      }. Data: ${JSON.stringify(error.response.data)}`;
      console.error(detailedLog);
      if (error.response.status === 403) {
        userErrorMessage =
          "Permission denied accessing Google Sheet (HTTP 403). Check credentials and sheet permissions.";
        console.error(
          "Specific Error: HTTP 403 Forbidden. Could be credentials or permissions."
        );
      } else if (error.response.status === 404) {
        userErrorMessage =
          "Google Sheet endpoint not found (HTTP 404). Check GOOGLE_SHEET_ID or API endpoint validity.";
        console.error(
          "Specific Error: HTTP 404 Not Found. Check GOOGLE_SHEET_ID."
        );
      } else {
        userErrorMessage = `Server responded with error code ${error.response.status}.`;
      }
    } else if (
      error.message.includes("Unable to load service account credentials") ||
      error.message.includes("Could not load the default credentials")
    ) {
      userErrorMessage =
        "Could not find Application Default Credentials or Service Account Key. Ensure credentials are configured correctly.";
      console.error(
        "Specific Error: Credential loading failed. Run 'gcloud auth application-default login' or check service account key path/environment variables."
      );
      detailedLog = error.message; // Keep the original message for this specific case
    } else if (
      error.name === "TypeError" &&
      error.message.includes("sheetsByTitle")
    ) {
      userErrorMessage =
        "Failed to load sheet details, possibly due to an earlier authentication/permission issue. Check previous logs.";
      console.error(
        "Specific Error: TypeError accessing sheetsByTitle. Likely caused by failed loadInfo() due to auth/permissions."
      );
      detailedLog = error.message;
    } else {
      // General catch-all for other errors (network issues, etc.)
      console.error(`Caught other error: ${error.message}`);
    }
    // --- END EDIT ---

    console.error("------------------------------------");
    // Return both user-friendly message and more detailed internal log/message
    return { success: false, error: userErrorMessage, details: detailedLog };
  }
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
  // Pass the Google Sheet ID to the template
  res.render("index", { google_sheet_id: GOOGLE_SHEET_ID || "", error: null });
});

app.get("/load_prompts", async (req, res) => {
  console.log("Attempting to load prompts from Google Sheet...");
  const result = await getPromptsFromSheet();
  if (result.success) {
    console.log(`Successfully loaded ${result.prompts.length} prompts.`);
    // Join prompts with newline for easy insertion into textarea
    const promptsText = result.prompts.join("\n");
    res.json({ success: true, prompts: promptsText });
  } else {
    console.error(`Failed to load prompts. Error: ${result.error}`);
    // Send error details back to the client
    res.status(500).json({ success: false, error: result.error });
  }
});

app.post("/generate", async (req, res) => {
  const promptsInput = req.body.prompts; // Get prompts from the form textarea
  if (!promptsInput) {
    return res.render("index", {
      google_sheet_id: GOOGLE_SHEET_ID || "",
      error: "Please enter at least one prompt.",
    });
  }

  // Split prompts by newline and remove empty lines/whitespace
  const prompts = promptsInput
    .split(/\r?\n/) // Handles both Windows and Unix newlines
    .map((p) => p.trim())
    .filter((p) => p); // Remove empty strings

  if (prompts.length === 0) {
    return res.render("index", {
      google_sheet_id: GOOGLE_SHEET_ID || "",
      error: "No valid prompts entered.",
    });
  }

  // Check for API Key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    // Render results page with a server configuration error
    return res.render("results", {
      results: [], // Pass empty results array
      error: "Server configuration error: API key not set.",
    });
  }

  const resultsList = [];
  console.log(`Generating images for ${prompts.length} prompts...`);

  // Process prompts sequentially - can be parallelized with Promise.all for performance
  for (const prompt of prompts) {
    console.log(`Generating image for prompt: '${prompt}'`);
    const result = await generateImage(prompt, apiKey);
    const generationInfo = { prompt: prompt }; // Store prompt with its result

    if (result.success) {
      console.log(`  Success for prompt: '${prompt}'`);
      // Prepend the data URI scheme for direct embedding in HTML
      generationInfo.image_data_uri = `data:image/png;base64,${result.b64_json}`;
    } else {
      console.error(`  Failed for prompt: '${prompt}'. Error: ${result.error}`);
      generationInfo.error = result.error;
      generationInfo.error_details = result.details; // Include details if available
    }
    resultsList.push(generationInfo);
  }

  console.log("Finished generating all images.");
  // Pass the list of results to the template
  res.render("results", { results: resultsList, error: null }); // Pass null error if generation process completed
});

// --- Run the App ---
// Check for environment variables at startup (optional, but good practice)
const apiKey = process.env.OPENAI_API_KEY;
const googleSheetId = process.env.GOOGLE_SHEET_ID;

let startupOk = true;
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY environment variable is not set.");
  startupOk = false;
}
if (!googleSheetId) {
  console.error("Error: GOOGLE_SHEET_ID environment variable is not set.");
  startupOk = false;
}

if (!startupOk) {
  console.error(
    "\nPlease set the required environment variables in a .env file or the environment."
  );
  // process.exit(1); // Exit if critical variables are missing - uncomment if needed
} else {
  console.log("API Key found.");
  console.log(`Google Sheet ID set: ${googleSheetId}`);
  console.log(
    "Attempting to use Application Default Credentials or Service Account for Google Sheets."
  );
}

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
