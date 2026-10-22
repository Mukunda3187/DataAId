import { GoogleGenAI, Type } from '@google/genai';
import { QualityIssue, AIExplanation } from '../types/dataQuality';

let genAIClient: GoogleGenAI | null = null;

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '') {
    return null;
  }
  if (!genAIClient) {
    genAIClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return genAIClient;
}

export function isGeminiAvailable(): boolean {
  return !!getGenAIClient();
}

export async function explainQualityIssueWithAI(
  issue: QualityIssue,
  columnInfo?: { dataType: string; sampleValues?: any[] }
): Promise<AIExplanation> {
  const client = getGenAIClient();

  if (client) {
    try {
      const prompt = `
You are an expert Data Quality Engineer and Data Governance Specialist.
Analyze the following detected data quality anomaly and generate an actionable, structured diagnosis.

Issue Details:
- Issue ID: ${issue.id}
- Category: ${issue.category}
- Column: ${issue.column}
- Severity: ${issue.severity}
- Affected Rows Count: ${issue.affectedRows.length} (Row refs: ${issue.affectedRows.slice(0, 5).join(', ')})
- Problem Description: ${issue.description}
- Supporting Evidence: ${issue.evidence}
${issue.ruleViolated ? `- Violated Rule: ${issue.ruleViolated}` : ''}
${columnInfo ? `- Column Type: ${columnInfo.dataType}, Sample Values: ${JSON.stringify(columnInfo.sampleValues?.slice(0, 3))}` : ''}

Special Requirement for Missing Values:
If category is "missing_value", provide a suitable, realistic contextual word or imputed value in "proposedCorrection" matching the column domain (e.g. for City provide a real city name, for Department provide a real department like 'Operations', for Status provide 'Active', for Category provide a canonical category). Do not provide placeholder strings like "Unknown" when a realistic domain term can be inferred.

Respond strictly in valid JSON adhering to this exact schema:
{
  "simpleExplanation": "Clear, accessible explanation of what is wrong for non-technical stakeholders.",
  "whyItMatters": "Business and analytical impact of this anomaly (e.g. reporting bias, downstream ML errors, revenue miscalculations).",
  "potentialCause": "Most likely root cause (e.g. upstream form validation omission, legacy ERP data migration, typo).",
  "recommendedAction": "Concrete, step-by-step guidance on how to fix or address the issue.",
  "proposedCorrection": "Exact recommended corrected value or handling rule.",
  "assumptionsAndLimitations": "Assumptions made in this correction and any risks.",
  "requiresHumanReview": true or false
}
`;

      const response = await client.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              simpleExplanation: { type: Type.STRING },
              whyItMatters: { type: Type.STRING },
              potentialCause: { type: Type.STRING },
              recommendedAction: { type: Type.STRING },
              proposedCorrection: { type: Type.STRING },
              assumptionsAndLimitations: { type: Type.STRING },
              requiresHumanReview: { type: Type.BOOLEAN },
            },
            required: [
              'simpleExplanation',
              'whyItMatters',
              'potentialCause',
              'recommendedAction',
              'assumptionsAndLimitations',
              'requiresHumanReview',
            ],
          },
        },
      });

      const text = response.text;
      if (text) {
        const parsed = JSON.parse(text);
        return {
          simpleExplanation: parsed.simpleExplanation || issue.description,
          whyItMatters: parsed.whyItMatters || 'May impact downstream reporting and aggregate statistics.',
          potentialCause: parsed.potentialCause || 'Upstream data capture variance or migration issue.',
          recommendedAction: parsed.recommendedAction || issue.suggestedAction,
          proposedCorrection: parsed.proposedCorrection || String(issue.proposedValue ?? ''),
          assumptionsAndLimitations: parsed.assumptionsAndLimitations || 'Automated assessment based on current dataset sample.',
          requiresHumanReview: Boolean(parsed.requiresHumanReview),
          provider: 'Gemini 3.8-Flash',
        };
      }
    } catch (err) {
      console.warn('Gemini API call failed or encountered error, falling back to expert rule engine:', err);
    }
  }

  // Fallback: Expert Rule-Based Explanation (Predefined Expert Mode)
  return getExpertRuleExplanation(issue);
}

export function getExpertRuleExplanation(issue: QualityIssue): AIExplanation {
  switch (issue.category) {
    case 'missing_value':
      return {
        simpleExplanation: `Column "${issue.column}" contains omitted, null, or empty values across ${issue.affectedRows.length} record(s).`,
        whyItMatters: 'Missing values skew distribution metrics, distort machine learning model training, and cause null-pointer exceptions in data pipelines.',
        potentialCause: 'Non-mandatory UI input form fields, optional customer registration prompts, or database extraction filters.',
        recommendedAction: 'Validate with upstream source system. For numeric attributes, impute with column median; for categorical attributes, assign "Unknown / Verified Pending" or review individually.',
        proposedCorrection: String(issue.proposedValue ?? 'N/A'),
        assumptionsAndLimitations: 'Imputation assumes missingness is completely at random (MCAR). High-value financial records should be manually audited.',
        requiresHumanReview: issue.severity === 'critical' || issue.severity === 'high',
        provider: 'Rule-based Expert',
      };

    case 'duplicate_record':
      return {
        simpleExplanation: `Row(s) [${issue.affectedRows.join(', ')}] are exact replicas of an earlier transaction record.`,
        whyItMatters: 'Duplicate transactions artificially inflate revenue calculations, distort sales volume, and trigger duplicate billing or redundant delivery events.',
        potentialCause: 'Network retry mechanisms during checkout submission, double-clicking form submit, or batch merge conflicts.',
        recommendedAction: 'Deduplicate dataset by discarding the redundant occurrences and retaining the primary original record.',
        proposedCorrection: 'DROP_ROW',
        assumptionsAndLimitations: 'Assumes rows with identical field values across all attributes represent accidental duplicate submissions.',
        requiresHumanReview: false,
        provider: 'Rule-based Expert',
      };

    case 'inconsistent_category':
      return {
        simpleExplanation: `Inconsistent representations (such as mixed casing, abbreviations, or regional aliases) detected for values in column "${issue.column}".`,
        whyItMatters: 'Variations such as "hyderabad", "HYD", and "Hyderabad" break GROUP BY queries, aggregate summaries, and business intelligence dashboards.',
        potentialCause: 'Free-text input fields without dropdown autocomplete or integration between distinct legacy regional systems.',
        recommendedAction: `Standardize all occurrences to canonical title-case term "${issue.proposedValue}".`,
        proposedCorrection: String(issue.proposedValue ?? ''),
        assumptionsAndLimitations: 'Assumes common municipal abbreviations refer to the same metropolitan entity.',
        requiresHumanReview: false,
        provider: 'Rule-based Expert',
      };

    case 'invalid_format':
      return {
        simpleExplanation: `Field "${issue.column}" contains records violating expected format standards (such as malformed email syntax or non-existent calendar dates).`,
        whyItMatters: 'Malformed dates cause database ingestion crashes and broken time-series graphs; invalid emails lead to hard bounces and deliverability blacklisting.',
        potentialCause: 'Absence of client-side regex input validation or differences between locale date formats (MM/DD/YYYY vs DD/MM/YYYY).',
        recommendedAction: 'Standardize to ISO 8601 YYYY-MM-DD for dates and RFC 5322 regex for emails.',
        proposedCorrection: String(issue.proposedValue ?? ''),
        assumptionsAndLimitations: 'Format normalization requires validating the intended semantic order of ambiguous calendar numbers.',
        requiresHumanReview: true,
        provider: 'Rule-based Expert',
      };

    case 'business_rule_violation':
      return {
        simpleExplanation: `Data points violate domain business logic: ${issue.ruleViolated || issue.description}.`,
        whyItMatters: 'Negative unit prices or quantities in standard sales ledgers corrupt accounting statements and tax reporting.',
        potentialCause: 'System processing errors, inverted sign on return items without a separate return ledger flag, or testing entries.',
        recommendedAction: 'Verify return status. If the sign was inadvertently negated, convert to positive absolute value.',
        proposedCorrection: String(issue.proposedValue ?? ''),
        assumptionsAndLimitations: 'Assumes negative values in sale columns are clerical sign inversions unless explicitly designated as return refunds.',
        requiresHumanReview: true,
        provider: 'Rule-based Expert',
      };

    case 'potential_outlier':
      return {
        simpleExplanation: `Numeric value lies significantly beyond normal distribution thresholds (outside 1.5 × IQR interquartile range).`,
        whyItMatters: 'Extreme outliers heavily distort statistical means, variance calculations, and regression model coefficients.',
        potentialCause: 'Clerical data entry typo (e.g. accidental extra zeros, decimal point omission), or genuine high-value bulk wholesale transaction.',
        recommendedAction: 'Conduct domain audit. If confirmed as an error, adjust to standard catalog unit price; otherwise retain and document as special case.',
        proposedCorrection: String(issue.proposedValue ?? ''),
        assumptionsAndLimitations: 'Outlier detection flags statistical deviation, which does not inherently guarantee erroneousness.',
        requiresHumanReview: true,
        provider: 'Rule-based Expert',
      };

    default:
      return {
        simpleExplanation: issue.description,
        whyItMatters: 'May adversely affect analytical data reliability.',
        potentialCause: 'Upstream data capture inconsistency.',
        recommendedAction: issue.suggestedAction,
        proposedCorrection: String(issue.proposedValue ?? ''),
        assumptionsAndLimitations: 'Standard heuristic validation.',
        requiresHumanReview: true,
        provider: 'Rule-based Expert',
      };
  }
}

export async function generateMissingValueAlternatesAI(
  columnName: string,
  sampleValues: any[] = [],
  rowContext: Record<string, any> = {}
): Promise<string[]> {
  const client = getGenAIClient();
  if (client) {
    try {
      const prompt = `
You are an expert Data Quality Engineer and Domain Imputation Specialist.
A text column "${columnName}" contains a missing/null value in a dataset record.
Here are other existing valid sample values from this column: ${JSON.stringify(sampleValues.slice(0, 8))}
Other field values in this specific row: ${JSON.stringify(rowContext)}

Suggest 4 to 6 realistic, high-quality, domain-fitting alternate text replacement values for this missing value.
Never suggest "Unknown", "N/A", or "None". Suggest real domain words (e.g. realistic cities, department names, job titles, business statuses, categories).
Respond strictly in valid JSON as an array of strings:
["Option1", "Option2", "Option3", "Option4"]
`;
      const response = await client.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        }
      });
      if (response.text) {
        const parsed = JSON.parse(response.text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(String);
        }
      }
    } catch (err) {
      console.warn('Gemini generateMissingValueAlternatesAI failed, using fallback:', err);
    }
  }

  // Fallback heuristic alternates
  const name = columnName.toLowerCase();
  const validFreq = sampleValues.filter(v => v && String(v).trim() !== '' && !/null|none|nan|undefined/i.test(String(v)));
  if (validFreq.length >= 2) {
    return Array.from(new Set(validFreq.slice(0, 5).map(String)));
  }
  if (/dept|department/i.test(name)) return ['Operations', 'Engineering', 'Marketing', 'Sales', 'Finance', 'Human Resources'];
  if (/city/i.test(name)) return ['Chicago', 'New York', 'Seattle', 'Austin', 'San Francisco', 'Boston'];
  if (/country|nation/i.test(name)) return ['United States', 'Canada', 'United Kingdom', 'Germany', 'Australia'];
  if (/status/i.test(name)) return ['Active', 'Pending', 'Verified', 'Completed', 'Approved'];
  if (/category|type/i.test(name)) return ['Standard', 'Premium', 'Enterprise', 'Basic'];
  if (/role|title/i.test(name)) return ['Associate', 'Manager', 'Analyst', 'Specialist', 'Lead'];
  if (/payment|method/i.test(name)) return ['Credit Card', 'Bank Transfer', 'Corporate Invoice', 'PayPal'];
  if (/priority/i.test(name)) return ['Medium', 'High', 'Low', 'Critical'];
  if (/segment/i.test(name)) return ['Enterprise', 'Mid-Market', 'SMB', 'Consumer'];
  return ['Standard', 'Verified', 'Primary', 'Operational'];
}
