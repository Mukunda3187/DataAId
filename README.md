# DataAId — Automated Data Quality Monitoring & Safe Auto-Correction

DataAId is a full-stack data quality monitoring, anomaly detection, and safe auto-correction platform. Upload any CSV or Excel file to automatically detect missing values, duplicates, inconsistent categories, and outliers — and fix them interactively.

---

## Technology Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide Icons
- **Backend**: Node.js, Express, TypeScript (tsx), served via server.ts
- **File Parsing**: xlsx (for CSV and Excel files)
- **GenAI Diagnostics**: Google Gemini (optional — falls back to heuristic rules automatically)
- **Storage**: In-memory persistent storage per session

---

## Local Deployment — Step-by-Step

### Prerequisites

| Tool | Minimum Version | Download |
| :--- | :--- | :--- |
| **Node.js** | v18.0+ | https://nodejs.org |
| **npm** | v9.0+ | bundled with Node.js |

---

### Step 1 — Clone or Download the Project

If using Git:
```bash
git clone <repository-url>
cd dataAId
```

Or download and extract the ZIP, then open a terminal in the `dataAId` folder.

---

### Step 2 — Install Dependencies

```bash
npm install
```

If you get a peer dependency error, use:
```bash
npm install --legacy-peer-deps
```

---

### Step 3 — Set Up Environment Variables (Optional)

Copy the example file:

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

**macOS / Linux:**
```bash
cp .env.example .env
```

Open `.env` and optionally add your Google Gemini API key:
```env
GEMINI_API_KEY="your-gemini-api-key-here"
```

> No API key is required. The app works fully with its built-in heuristic analysis engine.

---

### Step 4 — Start the Application

```bash
npm run dev
```

You will see:
```
DataAId Full-Stack Server active on http://0.0.0.0:3000
```

Open your browser and go to:
```
http://localhost:3000
```

> **Important:** Always use `http://localhost:3000` in your browser, not `http://0.0.0.0:3000`.

---

### Step 5 — Use the Application

1. **Upload a Dataset** — Drag & drop or click to upload a `.csv`, `.xlsx`, or `.xls` file (up to 300 MB).
2. **Review Analysis** — See detected missing values, duplicates, inconsistent categories, and outliers.
3. **Correction Center** — Review AI-suggested fixes, edit values, approve or reject corrections.
4. **Download Cleaned Dataset** — Export the corrected dataset as CSV.
5. **View Report** — See a full before/after quality audit log.

---

### Troubleshooting

| Problem | Fix |
| :--- | :--- |
| `npm install` fails with peer deps error | Run `npm install --legacy-peer-deps` |
| `tsx` not found | Run `npx tsx server.ts` instead, or reinstall with `npm install` |
| App not opening at `http://0.0.0.0:3000` | Use `http://localhost:3000` — that is the correct local URL |
| Port 3000 already in use | Change `PORT=3000` in `.env` to another port like `PORT=3001` |
| Upload fails with 500 error | Ensure the file is valid CSV or Excel and not empty |
| `GEMINI_API_KEY` error | Check the key in `.env`, or leave it blank to use heuristic mode |

---

### Supported File Formats

| Format | Extension | Notes |
| :--- | :--- | :--- |
| CSV | `.csv` | Standard comma-separated, UTF-8 or ASCII |
| Excel | `.xlsx` | Modern Excel format |
| Excel (Legacy) | `.xls` | Older Excel format |

Maximum file size: **300 MB**
