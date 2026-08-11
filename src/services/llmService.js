const apiEndpoint = "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-pro-preview:generateContent";

/**
 * Helper to get API Key
 */
const getApiKey = () => {
  const apiKey = (process.env.LLM_API_KEY || process.env.REACT_APP_LLM_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("LLM API Key is missing. Please set LLM_API_KEY in .env");
  }
  return apiKey;
};

/**
 * Helper to parse LLM response text into JSON
 */
const parseLLMResponse = (text) => {
  if (!text) return null;
  
  // 1. Initial cleanup: remove Markdown code fences and whitespace
  let cleanText = text.replace(/```json|```/g, "").trim();
  
  // 2. Simple parse attempt
  try {
    return JSON.parse(cleanText);
  } catch (error) {
    // 3. Robust extraction: find the outermost {} or []
    const firstBrace = cleanText.indexOf('{');
    const firstBracket = cleanText.indexOf('[');
    const lastBrace = cleanText.lastIndexOf('}');
    const lastBracket = cleanText.lastIndexOf(']');

    let start = -1;
    let end = -1;

    // Determine if we should look for an object or an array
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      end = lastBrace;
    } else if (firstBracket !== -1) {
      start = firstBracket;
      end = lastBracket;
    }

    if (start !== -1 && end !== -1 && end > start) {
      const jsonCandidate = cleanText.substring(start, end + 1);
      try {
        return JSON.parse(jsonCandidate);
      } catch (innerError) {
        console.error("Failed to parse extracted JSON segment:", innerError.message);
        // Special case: sometimes LLM adds a trailing comma or weird char at the end
        // Try one last-ditch effort by cleaning common trailing issues
        try {
          const desperateClean = jsonCandidate
            .replace(/,\s*([}\]])/g, '$1') // Remove trailing commas
            .trim();
          return JSON.parse(desperateClean);
        } catch (desperateError) {
          console.error("Final desperate parse attempt failed");
        }
      }
    }
    
    console.error("JSON parsing failed. Raw response length:", text.length);
    console.error("Partial response preview:", text.substring(0, 200));
    return null;
  }
};

const parseLLMResponsealternate = (response) => {
  // Remove Markdown code fences and any surrounding whitespace
  const cleanResponse = response.replace(/```json|```/g, "").trim();

  // Safely parse the cleaned JSON string
  let jsonResponse;
  try {
    jsonResponse = JSON.parse(cleanResponse);
  } catch (error) {
    console.error("Error parsing JSON response:", error);
    return null;
  }

  console.log("JSON response:", jsonResponse);

  // Check each step to ensure data exists before accessing properties
  const parsedResponse = {
    title: jsonResponse.title,
    introduction: jsonResponse.introduction,
    topics: jsonResponse.topics
      ? jsonResponse.topics.map((topic) => ({
          id: topic.id,
          topic: topic.topic,
          description: topic.description,
          subtopics: topic.subtopics
            ? topic.subtopics.map((subtopic) => ({
                id: subtopic.id,
                subtopic: subtopic.subtopic,
                description: subtopic.description,
                keyConcepts: subtopic.keyConcepts
                  ? subtopic.keyConcepts.map((concept) => ({
                      id: concept.id,
                      keyConcept: concept.keyConcept,
                      description: concept.description,
                      example: concept.example,
                      mnemonic: concept.mnemonic,
                    }))
                  : [],
              }))
            : [],
        }))
      : [],
    // conclusion: jsonResponse.conclusion,
  };

  return parsedResponse;
};

/**
 * Generic fetch from LLM with retry logic
 */
const fetchFromLLM = async (prompt, config = {}, maxRetries = 3) => {
  const apiKey = getApiKey();
  const fullEndpoint = `${apiEndpoint}?key=${apiKey}`;
  
  const nlData = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: config.temp || 1.0,
      maxOutputTokens: config.maxOutputTokens || 15000,
      ...config.generationConfig
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(fullEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nlData),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`LLM API Error (${response.status}):`, errorBody);
        throw new Error(`LLM API returned status ${response.status}: ${errorBody}`);
      }

      const responseData = await response.json();
      const rawText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log("Full response is", rawText);
      if (!rawText) {
        throw new Error("Empty response from LLM");
      }

      const parsedData = parseLLMResponse(rawText);
      console.log("full parsed data is", parsedData);
      if (parsedData) {
        return parsedData;
      }
    
      console.error("LLM Response failed validation. Raw text:", rawText);
      throw new Error("Failed to parse LLM response as JSON");
    
    } catch (error) {
      console.error(`LLM attempt ${i + 1} failed:`, error.message);
      lastError = error;
      // Exponential backoff or simple delay
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  }
  
  throw lastError || new Error("LLM request failed after retries");
};
const fetchFromLLMALT = async (prompt, config = {}, maxRetries = 3) => {
  const apiKey = getApiKey();
  const fullEndpoint = `${apiEndpoint}?key=${apiKey}`;
  
  const nlData = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: config.temp || 1.0,
      maxOutputTokens: config.maxOutputTokens || 5000,
      ...config.generationConfig
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(fullEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nlData),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`LLM API Error (${response.status}):`, errorBody);
        throw new Error(`LLM API returned status ${response.status}: ${errorBody}`);
      }

      const responseData = await response.json();
      const rawText = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!rawText) {
        throw new Error("Empty response from LLM");
      }

      const parsedData = parseLLMResponsealternate(rawText);
      console.log(parsedData);
      if (parsedData) {
        return parsedData;
      }
      
      console.error("LLM Response failed validation. Raw text:", rawText);
      throw new Error("Failed to parse LLM response as JSON");
    } catch (error) {
      console.error(`LLM attempt ${i + 1} failed:`, error.message);
      lastError = error;
      // Exponential backoff or simple delay
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  }
  
  throw lastError || new Error("LLM request failed after retries");
};
/**
 * Call LLM to generate study plan
 */
async function callLLM(role, country, numWords = "1000", temp = 1.0) {
  const prompt = `Create a structured study plan for a ${role} who wants to learn about ${country}. Please generate 5-15 topics(all of them relevant to ${country}). Each topic should have atleast 2-3 subtopics(treat this as priority 1 and fetch all subtopics that are relevant) and each subtopic should have 2-5 key concepts. Use clear and precise language, make sure the examples are concrete and relatable.

IMPORTANT: Follow these exact ID formats and numbering rules:
- Topics: Use format "t-1", "t-2", "t-3", etc. (Numbers restart from 1)
- Subtopics: For each topic, start numbering from 1. Example: For topic 1, use "st-1", "st-2", "st-3". For topic 2, again start from "st-1", "st-2", etc.
- Key Concepts: For each subtopic, start numbering from 1. Example: For each subtopic, use "kc-1", "kc-2", "kc-3", etc.

The response should only be a JSON object with the following structure:
{
  "title": "A concise title for the study plan",
  "introduction": "A brief introduction to the study area",
  "topics": [
    {
      "id": "t-1",
      "topic": "The name of the topic",
      "description": "A detailed description of the topic with mention of its significance to ${country}",
      "subtopics": [
        {
          "id": "st-1",  // Numbering restarts for each topic
          "subtopic": "The name of the subtopic",
          "description": "A detailed description of the subtopic",
          "keyConcepts": [
            {
              "id": "kc-1",  // Numbering restarts for each subtopic
              "keyConcept": "The name of the key concept",
              "description": "A detailed description of the concept",
              "example": "An example to illustrate the concept",
              "mnemonic": "A mnemonic to help remember the concept"
            }
          ]
        }
      ]
    }
  ]
}

Example of correct ID numbering:
Topic 1 (t-1):
  - Subtopic 1 (st-1):
    - Key Concept 1 (kc-1)
    - Key Concept 2 (kc-2)
  - Subtopic 2 (st-2):
    - Key Concept 1 (kc-1)
    - Key Concept 2 (kc-2)

Topic 2 (t-2):
  - Subtopic 1 (st-1):
    - Key Concept 1 (kc-1)
    - Key Concept 2 (kc-2)

Ensure all IDs strictly follow this level-wise numbering pattern where numbers restart at each new parent level.`;

  return await fetchFromLLM(prompt, { temp });
}

/**
 * Generate more subtopics for a topic
 */
async function generateMoreSubtopics(topicName, existingSubtopics = [], temp = 1.0) {
  // Guard clause to ensure existingSubtopics is always an array
  if (!Array.isArray(existingSubtopics)) {
    existingSubtopics = [];
  }
  const existingSubtopicsList = existingSubtopics
    .map((sub) => {
      if (!sub) return "";
      if (typeof sub === "string") return sub;
      return sub.subtopic || sub.name || "";
    })
    .filter(Boolean)
    .join(", ");

  const lastSubtopicNumber = existingSubtopics.length > 0
      ? Math.max(...existingSubtopics.map((st) => {
          if (!st || !st.id || typeof st.id !== "string") return 0;
          const parts = st.id.split("-");
          return parts.length > 1 ? (parseInt(parts[1], 10) || 0) : 0;
        }))
      : 0;

  const prompt = `Generate 5 additional subtopics for the topic "${topicName}" that are DIFFERENT from these existing subtopics: [${existingSubtopicsList}]. 

IMPORTANT: Follow these exact ID formats and numbering rules:
- Subtopics: Continue numbering from the last existing subtopic. Start with "st-${lastSubtopicNumber + 1}"
- Key Concepts: For each subtopic, start numbering from 1. Use format "kc-1", "kc-2", etc.

Each new subtopic should be unique and not overlap with the existing ones. Follow this JSON structure:
[
  {
    "id": "st-${lastSubtopicNumber + 1}",
    "subtopic": "The name of the subtopic (must be different from ${existingSubtopicsList})",
    "description": "A detailed description of the subtopic",
    "keyConcepts": [
      {
        "id": "kc-1",
        "keyConcept": "The name of the key concept",
        "description": "A detailed description of the concept",
        "example": "An example to illustrate the concept",
        "mnemonic": "A mnemonic to help remember the concept"
      }
    ]
  }
]`;

  return await fetchFromLLM(prompt, { temp });
}

/**
 * Generate detailed report for a subtopic
 */
async function generateDetailedReport(subtopic, keyConcepts, temp = 1.0) {
  const keyConceptsList = keyConcepts.map((c) => c.keyConcept).join(", ");
  const prompt = `Generate a detailed educational report for the subtopic "${subtopic}". The report should expand on these key concepts: [${keyConceptsList}].

For each key concept, provide:
1. A comprehensive explanation with real-world applications
2. Detailed examples and use cases
3. Common misconceptions and how to avoid them
4. Advanced insights and connections to other related concepts
5. Study tips and learning strategies

The response should be formatted as a JSON object with the following structure:
{
  "title": "The subtopic name",
  "overview": "A comprehensive overview of the subtopic",
  "keyConceptsAnalysis": [
    {
      "concept": "Name of the concept",
      "detailedExplanation": "In-depth explanation",
      "realWorldApplications": ["Application 1", "Application 2", ...],
      "examples": ["Example 1", "Example 2", ...],
      "commonMisconceptions": ["Misconception 1", "Misconception 2", ...],
      "advancedInsights": "Advanced connections and deeper understanding",
      "studyTips": ["Tip 1", "Tip 2", ...]
    }
  ],
  "recommendedResources": ["Resource 1", "Resource 2", ...],
  "practiceExercises": ["Exercise 1", "Exercise 2", ...]
}`;

  return await fetchFromLLM(prompt, { temp });
}

/**
 * Validate project topic
 */
async function validateProjectTopic(topic, levelOfLearning) {
  const prompt = `You are a validation system for educational project topics. Analyze the topic input below and determine if it has atleast 2 words and it makes sense as an educational domain for study.

Topic: "${topic}"

Respond with ONLY a JSON object in this exact format:
{
  "isValid": true or false,
  "reason": "Brief explanation of why it's valid or invalid (max 100 characters)"
}`;

  try {
    return await fetchFromLLM(prompt, { temp: 0.3, maxOutputTokens: 2000 });
  } catch (error) {
    console.error("Topic validation failed, failing open:", error.message);
    return { isValid: true, reason: "Validation service temporarily unavailable" };
  }
}

/**
 * Generate quiz questions for a topic
 */
async function generateQuizQuestions(topicName, projectTopic) {
  const projectContext = projectTopic
    ? `\nThis subtopic is part of a broader project/study plan on "${projectTopic}". Frame the questions so they reinforce how "${topicName}" fits within and supports understanding of "${projectTopic}".`
    : "";
  const prompt = `Generate exactly 5 multiple choice quiz questions about "${topicName}" for students looking to learn about the same or students looking to revise their conceptual understanding.${projectContext}

Requirements:
- Generate exactly 5 questions (no more, no less)
- Questions should be of low level difficulty
- Test conceptual understanding, not just memorization
- Include questions about practical applications, implications, and real-world scenarios
- Cover important relationships, theories, and concepts within the topic
- Each question should have 4 options (A, B, C, D) with one correct answer

Return the response in this exact JSON format:
[
  {
    "question": "Question text here",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": "Option A"
  },
  ...
]`;

  return await fetchFromLLM(prompt, { temp: 0.7 });
}

/**
 * Generate a single daily question
 */
async function generateDailyQuestion() {
  const prompt = `Generate exactly 1 interesting and educational multiple choice question that would be suitable for a daily challenge. The question should:
- Be engaging and thought-provoking
- Cover a diverse range of topics
- Be of intermediate difficulty
- Have exactly 4 options (A, B, C, D) with one clearly correct answer

Return the response in this exact JSON format:
{
  "question": "The question text here",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctAnswer": "Option A"
}`;

  return await fetchFromLLM(prompt, { temp: 0.8 });
}

/**
 * Parse syllabus PDF text and generate a mind map of topics
 */
async function parseSyllabusToMindMap(syllabusText) {
  const truncatedText = syllabusText.substring(0, 8000);
  const prompt = `You are an educational curriculum analyst. Analyze the following syllabus text and extract the main subject topics to create a structured mind map.

Syllabus Text:
"""
${truncatedText}
"""

Extract 5-12 main topics from this syllabus. For each topic, provide 2-5 subtopics. Focus on academic subjects, units, modules, or key learning areas mentioned.

Return ONLY a JSON object with this exact structure:
{
  "syllabusTitle": "Course or subject name inferred from content",
  "description": "Brief summary of what this syllabus covers (1-2 sentences)",
  "topics": [
    {
      "id": "t-1",
      "name": "Topic name",
      "description": "Brief description of this topic",
      "subtopics": ["Subtopic 1", "Subtopic 2", "Subtopic 3"]
    }
  ]
}`;

  return await fetchFromLLM(prompt, { temp: 0.3, maxOutputTokens: 4000 });
}

module.exports = {
  callLLM,
  generateMoreSubtopics,
  generateDetailedReport,
  validateProjectTopic,
  generateQuizQuestions,
  generateDailyQuestion,
  parseSyllabusToMindMap,
};
