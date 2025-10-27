# Content Lint

Content linting API for Figma plugin that analyzes UI text content against customizable guidelines using Google Gemini AI.

## Description

This API provides intelligent content analysis for Figma designs, helping maintain consistency in terminology, grammar, formatting, and style guidelines across design systems. It uses Google Gemini AI to identify violations and suggest corrections based on dynamic guidelines stored in a Supabase database.

## Features

- **Dynamic Guideline Processing**: Automatically processes and applies guidelines from Supabase database
- **AI-Powered Analysis**: Uses Google Gemini 2.0 Flash for accurate content linting
- **Caching System**: Efficiently caches analysis results and corrected text relationships to reduce API calls
- **Batch Processing**: Handles multiple text layers in parallel for better performance
- **Figma Plugin Integration**: Designed specifically for Figma plugin content linting
- **Timeout Protection**: Robust error handling and timeout management
- **Customizable Rules**: Support for various guideline categories and rule types

## Prerequisites

- Node.js (>= 14.x)
- Supabase account and database
- Google AI Studio API key (for Gemini)

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd content-lint
```

2. Install dependencies:
```bash
npm install
```

3. Create environment file:
```bash
cp .env.local.example .env.local
```

4. Configure your environment variables in `.env.local`:
```env
# Supabase Configuration
SUPABASE_URL=your-supabase-project-url
SUPABASE_ANON_KEY=your-supabase-anon-key

# Google AI API Key
GEMINI_API_KEY=your-gemini-api-key
```

## Project Structure

```
content-lint/
├── api/
│   └── analyze.js          # Main analysis endpoint
├── lib/                    # Utility libraries
├── package.json            # Project dependencies and scripts
├── vercel.json            # Vercel deployment configuration
├── .gitignore             # Git ignore rules
└── README.md              # This file
```

## API Usage

### POST /api/analyze

Analyzes text content against guidelines and returns linting results.

**Request Body:**
```json
{
  "textLayers": [
    {
      "id": "layer-1",
      "text": "Contact us at support@company.com"
    },
    {
      "id": "layer-2",
      "text": "Price: $99.99"
    }
  ],
  "clientHints": {
    "optimizationHint": "batch-process",
    "totalLayers": 10,
    "estimatedCompliant": 5
  }
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "id": "layer-1",
      "hasViolations": true,
      "violations": [
        {
          "original": "support@company.com",
          "suggested": "help@company.com",
          "confidence": 0.95,
          "ruleCategory": "Contact Information",
          "ruleDescription": "Use standardized support email"
        }
      ],
      "correctedText": "Contact us at help@company.com",
      "originalText": "Contact us at support@company.com",
      "confidence": 0.95,
      "guidelinesVersion": "abc123..."
    }
  ],
  "guidelines_info": {
    "totalGuidelines": 5,
    "categoriesProcessed": ["contact", "pricing", "typography"],
    "rulesExtracted": 25,
    "guidelinesVersion": "abc123..."
  },
  "optimization": {
    "totalOriginalLayers": 10,
    "clientPreFiltered": 3,
    "serverFiltered": 7,
    "preCompliantResults": 2,
    "cacheHits": 4,
    "relationshipHits": 1,
    "geminiAnalyzed": 1,
    "skippedAnalysis": 6,
    "optimizationRatio": 60
  },
  "stats": {
    "totalLayers": 2,
    "filteredLayers": 2,
    "analyzedLayers": 1,
    "cacheHits": 1,
    "relationshipHits": 0,
    "executionTimeMs": 1250
  }
}
```

### GET /api/analyze

Returns API status and configuration information.

**Response:**
```json
{
  "status": "dynamic-guideline-driven-system",
  "model": "gemini-2.5-flash-dynamic",
  "version": "8.0",
  "features": [
    "dynamic_guideline_processing",
    "comprehensive_rule_extraction",
    "scalable_analysis_system",
    "bidirectional_relationship_cache",
    "auto_adapting_prompts",
    "robust_guidelines_handling"
  ],
  "timestamp": "2025-10-27T15:30:00.000Z"
}
```

## Database Schema

### Guidelines Table
```sql
CREATE TABLE guidelines (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  rules JSONB,
  examples JSONB,
  is_active BOOLEAN DEFAULT true,
  version TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Analysis Cache Table
```sql
CREATE TABLE analysis_cache (
  cache_key TEXT PRIMARY KEY,
  analysis_result JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Text Relationships Table
```sql
CREATE TABLE text_relationships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  original_fingerprint TEXT NOT NULL,
  corrected_fingerprint TEXT NOT NULL,
  original_text TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  guidelines_version TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Development

### Local Development
```bash
npm run dev
```

The API will be available at `http://localhost:3000`

### Building and Testing
- Run locally with Vercel dev server
- Test endpoints using tools like Postman or curl
- Ensure all environment variables are properly configured

### Deployment

#### Vercel Deployment
1. Connect your GitHub repository to Vercel
2. Configure environment variables in Vercel dashboard
3. Deploy automatically on push to main branch

#### Manual Deployment
```bash
npm run deploy
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | Yes |
| `GEMINI_API_KEY` | Google Gemini API key | Yes |

## Error Handling

The API includes comprehensive error handling:
- **Timeout Protection**: Prevents hanging requests with configurable timeouts
- **Retry Logic**: Automatically retries failed analysis requests
- **Fallback Responses**: Provides reasonable responses when analysis fails
- **Logging**: Detailed logging for debugging and monitoring

## Performance Optimizations

- **Intelligent Caching**: Caches analysis results and text relationships
- **Parallel Processing**: Processes multiple layers concurrently
- **Optimized Prompts**: Dynamically generates prompts based on guidelines
- **Timeout Protection**: Prevents long-running requests from blocking the system

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For questions or support, please open an issue on GitHub or contact the development team.
