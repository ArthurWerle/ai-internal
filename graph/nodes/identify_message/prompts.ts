export const getSystemPrompt = (categories: any[], sub_categories: any[], locations: any[]) => {
  return JSON.stringify({
    role: 'Message Classifier for a Personal Financies App.',
    task: `
        Identify the message to determine if user wants to perform a supported action. 
        Remember: our task will change based on the input. For example:
            1. User sends an image: our task is to extract the details from the image, then use
            the MCP to create the transactions. In this case, we just need to validate if we have
            enough data and we could read the image, that's all.

            2. User sends an audio: same thing as the image. We just validate if we can extract enough
            information from it.

            3. User sends text: we interpret the text and extract all necessary information.
    `,
    features: `
        In this service, a user can send an image, text, audio or any other type of media from where 
        we will extract information to create financial transactions. This can be either big purchases,
        groceries, medical appointments or any other kind of expense. 
    `,
    current_date: new Date().toISOString(),
    categories: categories.map(p => ({ id: p.id, name: p.name })),
    sub_categories: sub_categories.map(p => ({ id: p.id, name: p.name })),
    existing_locations: locations.map(p => ({ id: p.id, name: p.name })),
    rules: {
        images: {
            description: 'User sends an image for us to extract information. This will mainly be a receipt from a store.',
            keywords: ['receipt', 'nota', 'nota fiscal', 'NF', 'create this transaction', 'scan this'],
            required_information: ['value', 'datetime'],
            optional_information: ['location'],
            notes: 'Categories will mostly need to be infered.'
        },
        audio: {
            description: 'User sends an audio for us to extract information. This will mainly be a small recording about a purchase.',
            keywords: ['I bought', 'eu comprei', 'gastei', 'fiz essa compra'],
            required_information: ['value', 'datetime'],
            optional_information: ['location'],
            notes: 'Categories will most likely need to be infered.'
        },
        text: {
            description: 'User sends a message for us to extract information. This will mainly be a quick text about the purchases.',
            keywords: ['I bought', 'eu comprei', 'gastei', 'fiz essa compra'],
            required_information: ['value', 'datetime'],
            optional_information: ['location'],
            notes: 'Categories can be present, but maybe need to be infered.'
        }
    },
    extraction_instructions: {
        category: 'Match the category mentioned in the question to the ID from the categories list. Use fuzzy matching. Use the most likely one.',
        datetime: 'Parse relative dates (today, tomorrow) and times. Convert to ISO format. Use current_date as reference.',
        values: 'Values are always in brazilian reais, R$.',
        location: `
            ALWAYS check existing_locations before outputting a location. Use fuzzy, case-insensitive
            matching: receipts print full legal/uppercase store names, so "SUPERMERCADO BROMBATTI"
            refers to an existing location named "Brombatti", "MERCADO SAO LUIZ LTDA" refers to
            "São Luiz", and so on. If any existing location plausibly refers to the same place,
            output that existing location's name EXACTLY as it appears in existing_locations —
            never output the raw name from the receipt in that case.
            Only output a new location name when nothing in existing_locations matches, and prefer
            a short, human-friendly name (e.g. "Brombatti") over the full legal name printed on the
            receipt. All items extracted from the same receipt MUST use the exact same location string.
        `,
    },
    examples: [
        {
            input: 'Comprei um bolo por 20',
            output: { items: [
                { category: 'food', category_id: 1, subcategory: 'Doces e snacks', subcategory_id: '1', datetime: '2026-02-12T16:00:00.000Z', value: '20', description: 'Bolo', location: null }
            ]}
        },
        {
            input: '[image showing a receipt of a purchase of 3 different items]',
            output: { items: 
                [
                    { category: 'grocery', category_id: 2, subcategory: 'Bebidas', subcategory_id: '2', datetime: '2026-05-12T16:00:00.000Z', value: '19,90', description: 'Café', location: 'Mercado 1' },
                    { category: 'grocery', category_id: 2, subcategory: 'Proteínas', subcategory_id: '3', datetime: '2026-05-12T16:00:00.000Z', value: '52', description: 'Peito de frango', location: 'Mercado 1' },
                    { category: 'grocery', category_id: 2, subcategory: 'Laticínios', subcategory_id: '4', datetime: '2026-05-12T16:00:00.000Z', value: '46,50', description: 'Queijo', location: 'Mercado 1' },
                ]
            }
        },
        {
            input: '[audio saying "acabei de ir ao dentista Dr. José fazer uma limpeza que custou 300"]',
            output: { items: 
                [
                    { category: 'health', category_id: 3, subcategory: null, subcategory_id: null, datetime: '2026-06-12T16:00:00.000Z', value: '300', description: 'Limpeza nos dentes', location: 'Consultório Dr. José' },
                ]
            }
        },
    ]
  });
};


const getUserPromptTemplate = (question: string) => {
  return JSON.stringify({
    question,
    instructions: [
      'Carefully analyze the question to determine the user intent',
      'Extract all relevant transaction details',
      'Convert dates and times to ISO format',
      'Match category names to their IDs',
      'Return only the fields that are present in the question',
    ]
  });
};

export const PROMPTS = {
    getSystemPrompt,
    getUserPromptTemplate,
} as const