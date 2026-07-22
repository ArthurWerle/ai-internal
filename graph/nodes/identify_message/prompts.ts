import { CATEGORY_RULE, SUBCATEGORY_RULE, LOCATION_RULE } from '../../shared/classification_rules.ts';

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
            notes: 'Categories and subcategories will mostly need to be infered.'
        },
        audio: {
            description: 'User sends an audio for us to extract information. This will mainly be a small recording about a purchase.',
            keywords: ['I bought', 'eu comprei', 'gastei', 'fiz essa compra'],
            required_information: ['value', 'datetime'],
            optional_information: ['location'],
            notes: 'Categories and subcategories will most likely need to be infered.'
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
        category: `${CATEGORY_RULE}\nMatch the chosen category NAME to its ID (categoryId) from the categories list using fuzzy matching.`,
        subcategory: `${SUBCATEGORY_RULE}\nOutput the chosen subcategory as subcategoryId.`,
        datetime: `
            Parse relative dates (today, tomorrow) and times. Convert to ISO format. Use current_date as reference.
            A receipt has exactly ONE purchase datetime: every item extracted from the same receipt MUST use
            that exact same datetime. Never assign different dates to different items of one receipt.
            If no date is visible on the receipt, use current_date for all items. Double-check the year —
            it must never differ from the receipt (or from current_date when the receipt shows none).
        `,
        values: 'Values are always in brazilian reais, R$.',
        clarification: `
            Almost every image is a supermarket nota fiscal — assume supermarket and DO NOT ask in the
            normal case. Set needsClarification=true (and write clarificationQuestion in Brazilian
            Portuguese) ONLY when you genuinely cannot tell whether the purchase is from a supermarket
            or which establishment it came from, so picking the category would be a pure guess. When you
            ask, NO transaction is created until the user answers, so only ask when truly necessary.
        `,
        location: LOCATION_RULE,
    },
    examples: [
        {
            // Text, clearly NOT a supermarket (street fair) → prepared food eaten out = 'food'.
            input: 'Comprei um pastel na feira por 10',
            output: { items: [
                // e.g. category 1 = 'food', subcategory 1 = 'Doces e snacks'
                { categoryId: 1, subcategoryId: 1, datetime: '2026-02-12T16:00:00.000Z', value: 10, description: 'Pastel', location: 'Feira' }
            ]}
        },
        {
            // SUPERMARKET nota fiscal that includes a food/snack item (a coxinha): EVERY item is
            // 'grocery', including the coxinha, BECAUSE it was bought at the supermarket. Only the
            // subcategory reflects what each item is — the category never changes item by item.
            input: '[image of a supermarket nota fiscal with a coxinha, a detergent and a soda]',
            output: { items:
                [
                    // e.g. category 2 = 'grocery'; subcategories 5/6/2 = 'Doces e snacks'/'Limpeza'/'Bebidas'
                    { categoryId: 2, subcategoryId: 5, datetime: '2026-05-12T16:00:00.000Z', value: 8.90, description: 'Coxinha', location: 'Mercado 1' },
                    { categoryId: 2, subcategoryId: 6, datetime: '2026-05-12T16:00:00.000Z', value: 12.50, description: 'Detergente', location: 'Mercado 1' },
                    { categoryId: 2, subcategoryId: 2, datetime: '2026-05-12T16:00:00.000Z', value: 7.00, description: 'Refrigerante', location: 'Mercado 1' },
                ]
            }
        },
        {
            input: '[audio saying "acabei de ir ao dentista Dr. José fazer uma limpeza que custou 300"]',
            output: { items:
                [
                    // e.g. category 3 = 'health'; subcategoryId omitted because no subcategory matches
                    { categoryId: 3, datetime: '2026-06-12T16:00:00.000Z', value: 300, description: 'Limpeza nos dentes', location: 'Consultório Dr. José' },
                ]
            }
        },
        {
            // Genuinely ambiguous image → ask instead of guessing. No transaction is created.
            input: '[a blurry photo where it is unclear whether it is a supermarket nota fiscal or a restaurant bill]',
            output: {
                items: [],
                needsClarification: true,
                clarificationQuestion: 'Não consegui identificar se essa compra foi no supermercado ou em outro lugar. Onde foi?'
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
      'Match category and subcategory names to their IDs',
      'Return only the fields that are present in the question',
    ]
  });
};

export const PROMPTS = {
    getSystemPrompt,
    getUserPromptTemplate,
} as const