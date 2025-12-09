import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import crypto from 'crypto';

// Add this constant at the top with other configs
const MAX_LAYERS_PER_REQUEST = 25;
const OPTIMAL_BATCH_SIZE = 12;

// Init Supabase
let supabase;
try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('Missing Supabase environment variables');
  }
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
} catch (err) {
  console.error('Supabase initialization error:', err);
}

// Guidelines processing cache
let guidelinesCache = null;
let cachedGuidelinesHash = null;

// CORS headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Create a shared utility object
const TextUtils = {
  normalize: (text) => {
    return text
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\u00A0/g, ' ')
      .replace(/\u2013|\u2014/g, '-')
      .replace(/\u2018|\u2019/g, "'")
      .replace(/\u201C|\u201D/g, '"')
      .normalize('NFC');
  },
  createFingerprint: (text) => {
    const normalized = TextUtils.normalize(text);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).slice(0, 12);
  }
};

// --- Text normalization & fingerprinting ---
// Replace `normalizeText` calls with `TextUtils.normalize`
function createTextFingerprint(text) {
  return crypto.createHash('sha256').update(TextUtils.normalize(text)).digest('hex');
}

// Enhanced cache key with text normalization
function createNormalizedCacheKey(text, guidelinesHash) {
  const normalizedText = TextUtils.normalize(text);
  const textHash = crypto.createHash('sha256').update(normalizedText).digest('hex');
  return `${textHash}:${guidelinesHash}`;
}

// Create guidelines hash for version control
function createGuidelinesHash(guidelines) {
  const guidelinesString = JSON.stringify(guidelines.map(g => ({
    id: g.id,
    version: g.version,
    category: g.category,
    rules: g.rules,
    updated_at: g.updated_at
  })));
  return crypto.createHash('sha256').update(guidelinesString).digest('hex').slice(0, 16);
}

// --- TIMEOUT-PROTECTED cache functions ---
async function getCachedAnalysisWithTimeout(text, guidelinesHash, layerId, timeout = 2500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const cacheKey = createNormalizedCacheKey(text, guidelinesHash);
    const { data, error } = await supabase
      .from('analysis_cache')
      .select('analysis_result')
      .eq('cache_key', cacheKey)
      .abortSignal(controller.signal)
      .single();

    clearTimeout(timeoutId);

    if (error || !data) return null;

    return {
      ...data.analysis_result,
      id: layerId,
      fromCache: true,
      cacheKey
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`Cache retrieval timeout for ${layerId}:`, err.message);
    return null;
  }
}

async function setCachedAnalysisWithTimeout(text, guidelinesHash, result, timeout = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const cacheKey = createNormalizedCacheKey(text, guidelinesHash);
    const cacheData = {
      cache_key: cacheKey,
      analysis_result: {
        hasViolations: result.hasViolations,
        violations: result.violations,
        correctedText: result.correctedText,
        originalText: result.originalText,
        confidence: result.confidence,
        analyzedAt: new Date().toISOString()
      }
    };

    const { error } = await supabase
      .from('analysis_cache')
      .upsert(cacheData, { onConflict: 'cache_key' })
      .abortSignal(controller.signal);

    clearTimeout(timeoutId);

    if (error) {
      console.warn('Cache storage failed (non-critical):', error.message);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name !== 'AbortError') {
      console.warn('Cache storage failed (non-critical):', err.message);
    }
  }
}

// --- ENHANCED: Bidirectional text relationship tracking ---
async function storeTextRelationship(originalText, correctedText, guidelinesHash) {
  try {
    const originalFingerprint = createTextFingerprint(originalText);
    const correctedFingerprint = createTextFingerprint(correctedText);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const { error } = await supabase
      .from('text_relationships')
      .upsert({
        original_fingerprint: originalFingerprint,
        corrected_fingerprint: correctedFingerprint,
        original_text: TextUtils.normalize(originalText),
        corrected_text: TextUtils.normalize(correctedText),
        guidelines_version: guidelinesHash
      }, {
        onConflict: 'original_fingerprint,corrected_fingerprint'
      })
      .abortSignal(controller.signal);

    clearTimeout(timeoutId);

    if (error) {
      console.warn('Text relationship storage failed (non-critical):', error.message);
    } else {
      console.log(`🔗 Stored relationship: "${originalText}" -> "${correctedText}"`);
    }
  } catch (err) {
    console.warn('Text relationship storage failed (non-critical):', err.message);
  }
}

async function checkIfTextIsCorrectedVersion(text, guidelinesHash) {
  try {
    const textFingerprint = createTextFingerprint(text);

    const { data, error } = await supabase
      .from('text_relationships')
      .select('original_text, corrected_text')
      .eq('corrected_fingerprint', textFingerprint)
      .eq('guidelines_version', guidelinesHash)
      .limit(1);

    if (error || !data?.length) return null;

    return {
      isKnownCorrectedText: true,
      originalText: data[0].original_text,
      correctedText: data[0].corrected_text,
      reason: 'recognized_as_corrected_version'
    };
  } catch (err) {
    console.error('Corrected text check error:', err);
    return null;
  }
}

// ENHANCED: Relationship-aware cache check
async function getCachedAnalysisWithRelationships(text, guidelinesHash, layerId, timeout = 2500) {
  const cachedResult = await getCachedAnalysisWithTimeout(text, guidelinesHash, layerId, timeout);
  if (cachedResult) {
    return cachedResult;
  }

  const correctedVersionCheck = await checkIfTextIsCorrectedVersion(text, guidelinesHash);
  if (correctedVersionCheck) {
    console.log(`🎯 Recognized "${text}" as corrected version of "${correctedVersionCheck.originalText}"`);

    return {
      id: layerId,
      hasViolations: false,
      violations: [],
      correctedText: text,
      originalText: text,
      confidence: 0.95,
      guidelinesVersion: guidelinesHash,
      recognizedAsCorrected: true,
      originalTextBefore: correctedVersionCheck.originalText,
      fromRelationshipCache: true
    };
  }

  return null;
}

// ENHANCED: Cache corrections with relationship storage
async function cacheCorrectionsAsCompliantWithRelationships(results, guidelinesHash) {
  const cachePromises = results
    .filter(result => result.hasViolations && result.correctedText !== result.originalText)
    .map(async (result) => {
      const compliantEntry = {
        hasViolations: false,
        violations: [],
        correctedText: result.correctedText,
        originalText: result.correctedText,
        confidence: 0.95,
        analyzedAt: new Date().toISOString(),
        markedAsCompliant: true
      };

      try {
        await setCachedAnalysisWithTimeout(result.correctedText, guidelinesHash, compliantEntry, 6000);
        await storeTextRelationship(result.originalText, result.correctedText, guidelinesHash);

        console.log(`💾 Cached corrected text as compliant AND stored relationship: "${result.originalText}" -> "${result.correctedText}"`);
      } catch (err) {
        console.warn(`Cache storage failed for result: ${err.message}`);
      }
    });

  await Promise.allSettled(cachePromises);
}

function createCompliantResult(layer, guidelinesHash) {
  return {
    id: layer.id,
    hasViolations: false,
    violations: [],
    correctedText: layer.text,
    originalText: layer.text,
    confidence: 0.95,
    guidelinesVersion: guidelinesHash,
    preFiltered: true,
    reason: layer.likelyCompliant ? 'client_heuristics' : 'recently_fixed'
  };
}

async function performOptimizedCacheCheckWithRelationships(textLayers, guidelinesHash, timeout = 3000) {
  const preCompliantLayers = textLayers.filter(layer => layer.likelyCompliant === true);
  const needsAnalysisLayers = textLayers.filter(layer => layer.likelyCompliant !== true);

  console.log(`📊 Pre-analysis optimization: ${preCompliantLayers.length} pre-compliant, ${needsAnalysisLayers.length} need cache check`);

  const preCompliantResults = preCompliantLayers.map(layer =>
    createCompliantResult(layer, guidelinesHash)
  );

  const cacheResults = await Promise.allSettled(
    needsAnalysisLayers.map(async (layer) => {
      try {
        const cached = await getCachedAnalysisWithRelationships(layer.text, guidelinesHash, layer.id, timeout / Math.max(needsAnalysisLayers.length, 1));
        return { layer, cached };
      } catch (err) {
        return { layer, cached: null };
      }
    })
  );

  const cachedResults = [];
  const uncachedLayers = [];

  cacheResults.forEach((result) => {
    if (result.status === 'fulfilled' && result.value.cached) {
      cachedResults.push(result.value.cached);
    } else if (result.status === 'fulfilled') {
      uncachedLayers.push(result.value.layer);
    } else {
      uncachedLayers.push(result.reason?.layer || null);
    }
  });

  return {
    cachedResults: [...preCompliantResults, ...cachedResults],
    uncachedLayers: uncachedLayers.filter(Boolean)
  };
}

// --- DYNAMIC GUIDELINES PROCESSING ---

/**
 * Recursively extract rules from nested guideline structure
 */
function extractRulesRecursively(obj, parentCategory = '', parentId = '', path = []) {
  const extractedRules = [];

  if (!obj || typeof obj !== 'object') return extractedRules;

  // Handle arrays
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      extractedRules.push(...extractRulesRecursively(item, parentCategory, parentId, [...path, index]));
    });
    return extractedRules;
  }

  // Handle objects
  Object.entries(obj).forEach(([key, value]) => {
    const currentPath = [...path, key];

    // Handle objects with enforcement_context - preserve contextual logic
    if (typeof value === 'object' && value !== null && value.enforcement_context) {
      const ruleId = `${parentId}-${currentPath.join('-')}`;
      const context = value.enforcement_context;

      // Build contextual description from enforcement_context
      let contextDescription = value.description || `${key} rule`;

      if (context.ideal) {
        contextDescription += `. Prefer "${context.ideal}" when space allows`;
      }
      if (context.abbreviation) {
        contextDescription += `. Use "${context.abbreviation}" only under space constraints`;
      }
      if (context.required_triggers) {
        contextDescription += `. Only applies when: ${context.required_triggers.join(', ')}`;
      }
      if (context.exclude_patterns) {
        contextDescription += `. EXCEPT: ${context.exclude_patterns.join(', ')}`;
      }
      if (context.when_space_constrained !== undefined) {
        contextDescription += context.when_space_constrained ?
          '. Use abbreviated forms when space is constrained' :
          '. Full forms preferred regardless of space';
      }
      if (context.avoid) {
        contextDescription += `. Avoid: ${context.avoid}`;
      }

      extractedRules.push({
        id: ruleId,
        category: parentCategory,
        path: currentPath.join(' → '),
        key: key,
        description: contextDescription,
        value: contextDescription,
        enforcement_context: context, // Preserve full context for prompt generation
        severity: 'medium',
        ruleType: 'contextual_rule',
        examples: []
      });
    }
    // If value is an object/array, recurse deeper
    else if (typeof value === 'object' && value !== null) {
      extractedRules.push(...extractRulesRecursively(value, parentCategory, parentId, currentPath));
    } else if (typeof value === 'string') {
      // Extract string rules
      const ruleId = `${parentId}-${currentPath.join('-')}`;
      extractedRules.push({
        id: ruleId,
        category: parentCategory,
        path: currentPath.join(' → '),
        key: key,
        description: value,
        value: value,
        severity: 'medium',
        ruleType: 'text_rule',
        examples: []
      });
    }
  });

  return extractedRules;
}

/**
 * Enhanced rule extraction that handles any guideline structure
 */
function extractComprehensiveRules(guidelines) {
  console.log('📋 Processing guidelines:', guidelines.length, 'categories');

  const allRules = [];

  guidelines.forEach(guideline => {
    try {
      const category = guideline.category || 'general';
      const guidelineId = guideline.id || 'unknown';

      // Extract rules from the rules object
      let rulesData = guideline.rules;

      // Handle different possible structures for rules
      if (typeof rulesData === 'string') {
        try {
          rulesData = JSON.parse(rulesData);
        } catch (e) {
          rulesData = { description: rulesData };
        }
      }

      if (!rulesData) {
        rulesData = {
          title: guideline.title || 'General Rule',
          description: guideline.description || 'General guideline'
        };
      }

      // Extract rules recursively from the rules structure
      const extractedRules = extractRulesRecursively(rulesData, category, guidelineId);

      // Also process examples if they exist
      if (guideline.examples) {
        const exampleRules = extractRulesRecursively(guideline.examples, category, `${guidelineId}-examples`, ['examples']);
        extractedRules.push(...exampleRules);
      }

      // Add high-level rule for the entire guideline
      allRules.push({
        id: `${guidelineId}-main`,
        category: category,
        description: guideline.title || 'General guideline',
        severity: 'high',
        ruleType: 'category_rule',
        examples: [],
        detailedRules: extractedRules
      });

      // Add all extracted sub-rules
      allRules.push(...extractedRules);

    } catch (error) {
      console.error(`Error processing guideline ${guideline.id}:`, error);
      // Add fallback rule
      allRules.push({
        id: `${guideline.id}-fallback`,
        category: guideline.category || 'general',
        description: guideline.title || 'General compliance rule',
        severity: 'medium',
        ruleType: 'fallback_rule',
        examples: []
      });
    }
  });

  console.log(`🔧 Extracted ${allRules.length} rules from ${guidelines.length} guidelines`);
  return allRules;
}

function createDynamicSystemPrompt(guidelines, guidelinesHash) {
  // Generate comprehensive rules first to access contextual information
  const allRules = extractComprehensiveRules(guidelines);

  const categorizedGuidelines = {};
  guidelines.forEach(guideline => {
    const category = guideline.category || 'general';
    if (!categorizedGuidelines[category]) {
      categorizedGuidelines[category] = [];
    }
    categorizedGuidelines[category].push(guideline);
  });

  let rulesSection = '\n\nGUIDELINES TO ENFORCE:\n';

  Object.entries(categorizedGuidelines).forEach(([category, categoryGuidelines]) => {
    rulesSection += `\n## ${category.toUpperCase()}:\n`;

    categoryGuidelines.forEach((guideline, index) => {
      rulesSection += `\n${index + 1}. ${guideline.title}:\n`;

      const rulesData = typeof guideline.rules === 'string'
        ? (() => { try { return JSON.parse(guideline.rules); } catch { return {}; } })()
        : guideline.rules || {};

      // Extract and inject detection patterns if present
      if (rulesData.detect_patterns && Array.isArray(rulesData.detect_patterns)) {
        rulesSection += `   🔍 DETECT: ${rulesData.detect_patterns.join(' | ')}\n`;
      }

      // Extract exclude patterns
      if (rulesData.exclude_patterns && Array.isArray(rulesData.exclude_patterns)) {
        rulesSection += `   🚫 EXCLUDE: ${rulesData.exclude_patterns.join(' | ')}\n`;
      }

      // Use contextual rules with enforcement_context (prioritize these)
      const contextualRules = allRules.filter(rule =>
        rule.category === category &&
        rule.ruleType === 'contextual_rule' &&
        rule.enforcement_context
      );

      contextualRules.forEach(rule => {
        const context = rule.enforcement_context;
        rulesSection += `   • ${rule.key}: ${rule.description}\n`;

        // Add specific contextual guidance
        if (context.ideal) {
          rulesSection += `     → PREFER: "${context.ideal}" when space allows\n`;
        }
        if (context.abbreviation) {
          rulesSection += `     → ABBREVIATE: "${context.abbreviation}" only when space is constrained\n`;
        }
        if (context.avoid) {
          rulesSection += `     → AVOID: ${context.avoid}\n`;
        }
        if (context.required_triggers && context.required_triggers.length > 0) {
          rulesSection += `     → ONLY WHEN: ${context.required_triggers.join(' OR ')}\n`;
        }
        if (context.exclude_patterns && context.exclude_patterns.length > 0) {
          rulesSection += `     → EXCEPT: ${context.exclude_patterns.join(' | ')}\n`;
        }
        if (context.when_space_constrained !== undefined) {
          rulesSection += context.when_space_constrained ?
            `     → Use abbreviated forms when space is constrained\n` :
            `     → Full forms preferred regardless of space constraints\n`;
        }
      });

      // Fallback to legacy flat rules for non-contextual entries
      Object.entries(rulesData).forEach(([key, value]) => {
        // Skip if we already processed this as a contextual rule
        if (contextualRules.some(r => r.key === key)) return;

        if (key === 'date_format' && typeof value === 'string') {
          rulesSection += `   • ${key}: ${value}\n`;
          rulesSection += `     DD/MM/YYYY for compact display. "15 October, 2023" is VALID when space permits. Only flag: MM/DD/YYYY, ordinals (15th), or YYYY/MM/DD.\n`;
        } else if (key === 'time_format' && typeof value === 'string') {
          rulesSection += `   • ${key}: ${value}\n`;
          rulesSection += `     "11:00 am to 12:00 pm" is VALID. Avoid unnecessary complexity.\n`;
        } else if (typeof value === 'string') {
          rulesSection += `   • ${key}: ${value}\n`;
        } else if (typeof value === 'object' && Array.isArray(value)) {
          rulesSection += `   • ${key}: ${value.join(', ')}\n`;
        }
      });

      // Add examples
      if (guideline.examples) {
        const { correct = [], incorrect = [] } = guideline.examples;
        if (correct.length > 0) {
          rulesSection += `   ✅ ${correct.slice(0, 2).join(' | ')}\n`;
        }
        if (incorrect.length > 0) {
          rulesSection += `   ❌ ${incorrect.slice(0, 2).join(' | ')}\n`;
        }
      }
    });
  });

  return `You are a PRECISE compliance analyzer for Indian UI content. Version: ${guidelinesHash}

CRITICAL CONTEXT:
- Client already fixed mechanical issues (currency symbols, basic commas, obvious errors)
- Focus on SEMANTIC, CONTEXTUAL, and TONE violations that regex cannot catch
- Be confident: Only flag clear violations with ≥85% certainty
- RESPECT SPACE CONSTRAINTS: Use abbreviations only when necessary, prefer full forms when space allows

${rulesSection}

ANALYSIS METHOD:
1. Check tone appropriateness (error/success/info context)
2. Validate complex number formatting (Lakh/Crore usage)
3. Detect passive voice patterns
4. Check UK vs US spelling variants
5. Verify punctuation context (heading vs body)
6. Assess politeness overuse (multiple please/sorry)
7. Honor contextual constraints (space, formality, brevity)

RESPONSE FORMAT - STRICT JSON:
[{
  "id": "layer_id",
  "hasViolations": true/false,
  "violations": [{
    "original": "exact text",
    "suggested": "corrected text",
    "confidence": 0.85-0.99,
    "ruleCategory": "tone/localisation/grammar/etc",
    "ruleDescription": "specific rule violated"
  }],
  "correctedText": "full corrected version",
  "confidence": 0.85-0.99
}]

IMPORTANT:
- RESPECT CONTEXT: If space allows, use preferred full forms over abbreviations
- ALLOW VALID VARIATIONS: "15 October, 2023" and "11:00 am to 12:00 pm" are both acceptable
- SINGLE "PLEASE" IS OK: Allow one instance of politeness without over-flagging
- If client already fixed it, do not re-flag
- Only suggest changes you are confident about (≥85%)
- correctedText must apply ALL fixes from violations array`;
}

/**
 * Generate rule descriptions from dynamic guidelines structure
 */
function generateRuleDescriptions(rulesData, category) {
  const descriptions = [];

  function processRulesObject(obj, prefix = '') {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach(item => {
        if (typeof item === 'string') {
          descriptions.push(`${prefix}${item}`);
        } else if (typeof item === 'object') {
          processRulesObject(item, prefix);
        }
      });
      return;
    }

    Object.entries(obj).forEach(([key, value]) => {
      if (typeof value === 'string') {
        const description = prefix
          ? `${prefix} ${key}: ${value}`
          : `${key}: ${value}`;
        descriptions.push(description);
      } else if (typeof value === 'object' && value !== null) {
        const newPrefix = prefix ? `${prefix} ${key}` : key;
        processRulesObject(value, `${newPrefix} -`);
      }
    });
  }

  processRulesObject(rulesData);
  return descriptions.length > 0 ? descriptions : [`Check ${category} compliance`];
}

// --- Enhanced Gemini analysis with dynamic guidelines ---
async function analyzeWithGeminiDynamic(textLayers, guidelines, guidelinesHash, timeout = 15000) {
  const systemPrompt = createDynamicSystemPrompt(guidelines, guidelinesHash);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log(`⚠️ Gemini timeout after ${timeout}ms for ${textLayers.length} layers`);
    controller.abort();
  }, timeout);

  let retries = 2;
  while (retries > 0) {
    try {
      console.log(`🔍 Dynamic analysis: ${textLayers.length} layers, ${guidelines.length} guidelines, attempt ${3 - retries}`);

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${systemPrompt}\n\nANALYZE THESE TEXT LAYERS AGAINST ALL GUIDELINES:\n\n${JSON.stringify(textLayers.map(l => ({ id: l.id, text: l.text })))}`
            }]
          }],
          generationConfig: {
            temperature: 0.05,
            topK: 40,
            topP: 0.9,
            maxOutputTokens: 4096,
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
          ]
        })
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini ${response.status}: ${errorText.slice(0, 100)}`);
      }

      const data = await response.json();
      let content = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      content = content.trim()
        .replace(/```json\s*/gi, '')
        .replace(/```/g, '')
        .replace(/^[^[\{]*/, '')
        .replace(/[^}\]]*$/, '')
        .trim();

      if (!content) {
        throw new Error('Empty Gemini response');
      }

      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        throw new Error('Invalid response format');
      }

      const results = parsed.map(result => {
        const originalLayer = textLayers.find(l => l.id === result.id);
        const originalText = originalLayer?.text || '';

        let correctedText = result.correctedText || originalText;
        let hasViolations = Boolean(result.violations && result.violations.length > 0);

        const processedViolations = Array.isArray(result.violations) ? result.violations.filter(v =>
          v.original && v.suggested &&
          v.original.trim() !== v.suggested.trim() &&
          originalText.includes(v.original)
        ).map(v => ({
          original: v.original.trim(),
          suggested: v.suggested.trim(),
          confidence: Math.min(1.0, Math.max(0.85, v.confidence || 0.90)),
          ruleCategory: v.ruleCategory || 'General',
          ruleDescription: v.ruleDescription || 'Guideline violation'
        })) : [];

        // Apply post-processing to filter false positives
        const postProcessViolations = (originalText, violations) => {
          return violations.filter(v => {
            // ❌ Don't flag full date format as violation
            if (v.ruleDescription?.includes('date') &&
                /\b\d{1,2}\s+[A-Za-z]+\s*,?\s+\d{4}\b/.test(originalText)) {
              return false; // e.g., "15 October, 2023" is valid
            }
            // ❌ Don't flag "to" in time ranges
            if (v.ruleDescription?.includes('time') &&
                /\b\d{1,2}:\d{2}\s+[ap]m\s+to\s+\d{1,2}:\d{2}\s+[ap]m\b/i.test(originalText)) {
              return false; // e.g., "11:00 am to 12:00 pm" is valid
            }
            // ❌ Don't flag single "please"
            if (v.original?.toLowerCase() === 'please' &&
                (originalText.match(/\bplease\b/gi)?.length || 0) === 1) {
              return false;
            }
            // ❌ Don't flag valid abbreviations when space allows full forms
            if (v.suggested && v.suggested.length < v.original.length &&
                /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(v.original) &&
                v.ruleDescription?.includes('space') === false) {
              // Only flag abbreviations if explicit space constraint mentioned
              return false;
            }
            return true;
          });
        };

        const filteredViolations = postProcessViolations(originalText, processedViolations);

        if (hasViolations && filteredViolations.length > 0) {
          if (!correctedText || correctedText === originalText) {
            correctedText = generateFallbackCorrection(originalText, filteredViolations);
          }

          let finalCorrectedText = correctedText;
          filteredViolations.forEach(v => {
            if (finalCorrectedText.includes(v.original) && !finalCorrectedText.includes(v.suggested)) {
              finalCorrectedText = finalCorrectedText.replace(new RegExp(escapeRegExp(v.original), 'g'), v.suggested);
            }
          });
          correctedText = finalCorrectedText;
        }

        if (correctedText === originalText && hasViolations && filteredViolations.length === 0) {
          hasViolations = false;
        }

        return {
          id: result.id,
          hasViolations: hasViolations,
          violations: filteredViolations,
          correctedText: correctedText,
          originalText: originalText,
          confidence: Math.min(1.0, Math.max(0.85, result.confidence || 0.90)),
          guidelinesVersion: guidelinesHash
        };
      });

      console.log(`✅ Dynamic analysis complete: ${results.length} results, ${results.filter(r => r.hasViolations).length} with violations`);
      return results;

    } catch (error) {
      retries--;
      clearTimeout(timeoutId);
      if (retries === 0) {
        console.error(`❌ Gemini analysis failed:`, error.message);
        throw error;
      }
      console.warn(`Retrying analysis (${retries} attempts left)...`);
    }
  }
}

// Replace the existing analyzeWithGeminiDynamicWithRelationships function with this:
async function analyzeWithGeminiDynamicWithRelationships(textLayers, guidelines, guidelinesHash, timeout = 15000) {
  // Use batched processing for large layer counts
  if (textLayers.length > 25) {
    return await analyzeWithGeminiDynamicBatched(textLayers, guidelines, guidelinesHash, timeout);
  }

  // Use single request for smaller counts
  const results = await analyzeWithGeminiDynamic(textLayers, guidelines, guidelinesHash, timeout);
  await cacheCorrectionsAsCompliantWithRelationships(results, guidelinesHash);
  return results;
}

// Add this new function after analyzeWithGeminiDynamicWithRelationships
// In analyzeWithGeminiDynamicBatched function, replace everything from line ~570 onwards:

async function analyzeWithGeminiDynamicBatched(textLayers, guidelines, guidelinesHash, timeout = 15000) {
  // Much more aggressive batching for scale
  const BATCH_SIZE = 12; // Larger batches
  const availableTime = timeout - 2000;
  const batches = [];

  // Split into batches
  for (let i = 0; i < textLayers.length; i += BATCH_SIZE) {
    batches.push(textLayers.slice(i, i + BATCH_SIZE));
  }

  console.log(`🔄 Parallel processing: ${textLayers.length} layers in ${batches.length} batches of ~${BATCH_SIZE}`);

  // **KEY CHANGE: Process batches in PARALLEL, not sequential**
  const batchPromises = batches.map(async (batch, i) => {
    try {
      console.log(`🔍 Starting batch ${i + 1}/${batches.length}: ${batch.length} layers`);

      // Give each batch 80% of available time (they run in parallel)
      const batchTimeout = Math.floor(availableTime * 0.8);
      const batchResults = await analyzeWithGeminiDynamic(batch, guidelines, guidelinesHash, batchTimeout);

      console.log(`✅ Batch ${i + 1} completed: ${batchResults.filter(r => r.hasViolations).length}/${batch.length} violations`);
      return batchResults;

    } catch (error) {
      console.error(`❌ Batch ${i + 1} failed:`, error.message);
      return createOptimizedFallback(batch, `batch_${i + 1}_failed`, guidelinesHash);
    }
  });

  // Wait for all batches to complete in parallel
  const batchResults = await Promise.allSettled(batchPromises);
  const allResults = batchResults.flatMap(result =>
    result.status === 'fulfilled' ? result.value : []
  );

  // Cache all results
  await cacheCorrectionsAsCompliantWithRelationships(allResults, guidelinesHash);

  console.log(`🎯 Parallel analysis complete: ${allResults.length} total results`);
  return allResults;
}

function generateFallbackCorrection(originalText, violations) {
  let corrected = originalText;

  if (Array.isArray(violations)) {
    violations.sort((a, b) => b.original.length - a.original.length);

    violations.forEach(v => {
      if (v.original && v.suggested && v.original !== v.suggested) {
        const regex = new RegExp(escapeRegExp(v.original), 'g');
        corrected = corrected.replace(regex, v.suggested);
      }
    });
  }

  return corrected;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createOptimizedFallback(layers, reason, guidelinesHash) {
  return layers.map(layer => ({
    id: layer.id,
    hasViolations: false,
    violations: [],
    correctedText: layer.text,
    originalText: layer.text,
    confidence: 0.5,
    guidelinesVersion: guidelinesHash,
    fallback: true,
    reason
  }));
}

// --- HELPER FUNCTIONS ---
function intelligentPreFilter(textLayers) {
  return textLayers.filter(layer => {
    if (!layer.text || !layer.text.trim()) return false;
    if (typeof layer.text !== 'string') return false;
    return true;
  });
}

// --- MAIN HANDLER ---
export default async function handler(req, res) {
  const startTime = Date.now();
  const HARD_TIMEOUT = 28000;
  const RESPONSE_BUFFER = 1000;

  const globalTimeout = setTimeout(() => {
    console.error(`🚨 GLOBAL TIMEOUT: ${HARD_TIMEOUT}ms exceeded`);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Analysis timeout - partial results returned',
        timeout: true,
        execution_time_ms: HARD_TIMEOUT
      });
    }
  }, HARD_TIMEOUT);

  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    clearTimeout(globalTimeout);
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    clearTimeout(globalTimeout);
    return res.status(200).json({
      status: 'dynamic-guideline-driven-system',
      model: 'gemini-2.5-flash-lite',
      version: '8.0',
      features: [
        'dynamic_guideline_processing',
        'comprehensive_rule_extraction',
        'scalable_analysis_system',
        'bidirectional_relationship_cache',
        'auto_adapting_prompts',
        'robust_guidelines_handling'
      ],
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    clearTimeout(globalTimeout);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      clearTimeout(globalTimeout);
      return res.status(500).json({ success: false, error: 'Gemini API key missing' });
    }

    const { textLayers, clientHints } = req.body || {};

    // ✅ ENFORCE BATCH-ONLY ARCHITECTURE
    if (!Array.isArray(textLayers) || textLayers.length === 0) {
      clearTimeout(globalTimeout);
      return res.status(400).json({
        success: false,
        error: 'Valid textLayers required'
      });
    }

    if (textLayers.length > MAX_LAYERS_PER_REQUEST) {
      clearTimeout(globalTimeout);
      return res.status(400).json({
        success: false,
        error: `Too many layers. Max ${MAX_LAYERS_PER_REQUEST} per request.`,
        hint: 'Split into batches on client side',
        layersReceived: textLayers.length,
        maxAllowed: MAX_LAYERS_PER_REQUEST,
        suggestedBatches: Math.ceil(textLayers.length / MAX_LAYERS_PER_REQUEST)
      });
    }

    console.log(`📊 Batch request: ${textLayers.length}/${MAX_LAYERS_PER_REQUEST} layers`);

    const optimizationHint = clientHints?.optimizationHint || 'unknown';
    const totalOriginalLayers = clientHints?.totalLayers || textLayers.length;
    const estimatedCompliant = clientHints?.estimatedCompliant || 0;
    const tier1PreProcessed = clientHints?.tier1PreProcessed || 0;

    console.log(`📊 Dynamic analysis starting: ${textLayers.length}/${totalOriginalLayers} layers (${estimatedCompliant} pre-filtered), ${HARD_TIMEOUT}ms limit`);

    // Load guidelines with timeout protection
    let guidelines;
    try {
      const guidelinesController = new AbortController();
      const guidelinesTimeout = setTimeout(() => guidelinesController.abort(), 3000);

      const { data, error } = await supabase
        .from('guidelines')
        .select('*')
        .eq('is_active', true)
        .order('category')
        .abortSignal(guidelinesController.signal);

      clearTimeout(guidelinesTimeout);

      if (error || !data?.length) {
        throw new Error(`Guidelines error: ${error?.message || 'No guidelines'}`);
      }

      guidelines = data;
      console.log(`📋 Guidelines loaded: ${guidelines.length} categories`);

    } catch (err) {
      console.error('Guidelines fetch failed:', err.message);
      clearTimeout(globalTimeout);
      return res.status(500).json({
        success: false,
        error: 'Guidelines unavailable',
        details: err.message
      });
    }

    const guidelinesHash = createGuidelinesHash(guidelines);
    let allRules;
if (cachedGuidelinesHash === guidelinesHash && guidelinesCache) {
  allRules = guidelinesCache;
  console.log(`📋 Using cached guidelines: ${allRules.length} rules`);
} else {
  allRules = extractComprehensiveRules(guidelines);
  guidelinesCache = allRules;
  cachedGuidelinesHash = guidelinesHash;
  console.log(`📋 Processed and cached guidelines: ${allRules.length} rules`);
}

    console.log(`🔧 Rules extracted: ${allRules.length} rules from ${guidelines.length} guidelines`);

    const filteredLayers = intelligentPreFilter(textLayers);
    const skippedCount = textLayers.length - filteredLayers.length;

    console.log(`🎯 Post-client filtering: ${filteredLayers.length} valid, ${skippedCount} skipped`);

    const results = [];
    let cacheHits = 0;
    let relationshipHits = 0;
    let uncachedLayers = [];

    if (filteredLayers.length > 0) {
      console.log(`💾 Enhanced cache check with relationships for ${filteredLayers.length} layers...`);

      try {
        const timeForCache = Math.min(3000, HARD_TIMEOUT - (Date.now() - startTime) - 5000);
        const { cachedResults, uncachedLayers: uncachedLayersFromCache } = await performOptimizedCacheCheckWithRelationships(filteredLayers, guidelinesHash, timeForCache);

        uncachedLayers = uncachedLayersFromCache;
        results.push(...cachedResults);
        cacheHits = cachedResults.length;
        relationshipHits = cachedResults.filter(r => r.fromRelationshipCache).length;

        console.log(`📊 Enhanced cache results: ${cacheHits} hits (${cachedResults.filter(r => r.preFiltered).length} pre-filtered, ${relationshipHits} relationship-based), ${uncachedLayers.length} layers need Gemini analysis`);

      } catch (err) {
        console.error('Enhanced cache failed:', err.message);
        uncachedLayers = filteredLayers.filter(layer => !layer.likelyCompliant);
      }

      // Only analyze layers that truly need Gemini analysis
      if (uncachedLayers.length > 0) {
        const timeRemaining = HARD_TIMEOUT - (Date.now() - startTime) - RESPONSE_BUFFER;
        if (timeRemaining <= 2000) {
          console.warn(`⏳ Insufficient time for Gemini analysis: ${timeRemaining}ms`);
          results.push(...createOptimizedFallback(uncachedLayers, 'insufficient_time', guidelinesHash));
        } else {
          try {
            // ✅ SIMPLIFIED: No internal batching needed anymore
            // Single Gemini call handles ≤25 layers easily
            const geminiResults = await analyzeWithGeminiDynamic(
              uncachedLayers,
              guidelines,
              guidelinesHash,
              timeRemaining - 1000
            );

            // Cache and store relationships
            await cacheCorrectionsAsCompliantWithRelationships(geminiResults, guidelinesHash);
            results.push(...geminiResults);

          } catch (err) {
            console.error('Gemini analysis failed:', err.message);
            results.push(...createOptimizedFallback(uncachedLayers, err.message, guidelinesHash));
          }
        }
      }
    }

    // Sort results to match original order
    results.sort((a, b) => textLayers.findIndex(l => l.id === a.id) - textLayers.findIndex(l => l.id === b.id));

    const preFilteredCount = results.filter(r => r.preFiltered).length;
    const geminiAnalyzedCount = uncachedLayers.length;

    // Debug logging for false positives analysis
    if (process.env.DEBUG_ANALYSIS) {
      const fpCandidates = results.filter(r =>
        r.violations.some(v =>
          /date|time|please|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(v.ruleDescription || '') &&
          !r.correctedText.includes(v.suggested) // self-corrected?
        )
      );
      if (fpCandidates.length > 0) {
        console.warn(`⚠️ Potential false positives detected:`, fpCandidates.map(r => ({
          id: r.id,
          original: r.originalText,
          violations: r.violations.map(v => ({
            original: v.original,
            suggested: v.suggested,
            rule: v.ruleDescription
          }))
        })));
      }
    }

    // Enhanced response with guidelines information
    const categoriesProcessed = [...new Set(guidelines.map(g => g.category))];

    clearTimeout(globalTimeout);
    res.status(200).json({
      success: true,
      results: results,
      guidelines_info: {
        totalGuidelines: guidelines.length,
        categoriesProcessed: categoriesProcessed,
        rulesExtracted: allRules.length,
        guidelinesVersion: guidelinesHash
      },
      optimization: {
        totalOriginalLayers,
        clientPreFiltered: totalOriginalLayers - textLayers.length,
        serverFiltered: filteredLayers.length,
        preCompliantResults: preFilteredCount,
        cacheHits: cacheHits - preFilteredCount,
        relationshipHits: relationshipHits,
        geminiAnalyzed: geminiAnalyzedCount,
        skippedAnalysis: textLayers.length - geminiAnalyzedCount,
        optimizationRatio: Math.round(((totalOriginalLayers - geminiAnalyzedCount) / totalOriginalLayers) * 100)
      },
      stats: {
        totalLayers: textLayers.length,
        filteredLayers: filteredLayers.length,
        analyzedLayers: geminiAnalyzedCount,
        cacheHits: cacheHits,
        relationshipHits: relationshipHits,
        executionTimeMs: Date.now() - startTime
      }
    });

  } catch (error) {
    console.error('Fatal error in handler:', error);
    clearTimeout(globalTimeout);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: error.message
    });
  }
}
