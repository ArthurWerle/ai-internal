// Single source of truth for the transaction-classification policy shared by
// the /scan pipeline (graph/nodes/identify_message/prompts.ts) and the /ask
// agent (graph/ask_agent.ts). Keeping these rules here means a change to the
// policy (e.g. how supermarket receipts map to categories) is made in ONE place
// instead of being copy-pasted into both prompts and drifting apart.
//
// The rules are written to be field-name-agnostic ("category", "subcategory",
// "location"). Each caller adds a short glue sentence mapping those concepts to
// its own field names — categoryId/subcategoryId for the /scan schema,
// category_id/subcategory_id for the /ask MCP tools.

// The category is defined by the ESTABLISHMENT, not by each item. This is what
// keeps every item of a supermarket receipt in "Grocery" instead of leaking
// food items into "Food".
export const CATEGORY_RULE = `
The category is HIGH-LEVEL and is defined by the ESTABLISHMENT, never item by item:
EVERY item extracted from the same receipt MUST get the SAME category.
DEFAULT ASSUMPTION: an image / nota fiscal is a SUPERMARKET purchase unless there is CLEAR
evidence it is another kind of establishment (a restaurant, a standalone bakery, a pharmacy,
a gas station, etc.). When it is a supermarket, EVERY single item — food, drinks, cleaning
supplies, hygiene, snacks, everything — gets the "Grocery" category.
A prepared / ready-to-eat item bought AT a supermarket (a coxinha, a bolo, pão, a salgado)
is STILL "Grocery", NEVER "Food", because it was bought at the supermarket. The item's nature
(food vs. drink vs. cleaning vs. hygiene) changes ONLY the subcategory, never the category.
"Food" is ONLY for meals / prepared food when the establishment is NOT a supermarket:
delivery, restaurants, a snack at a bar, a pastel at the street fair, a churro at the park.
`.trim();

// Always try to place item-level detail in the subcategory — that is where the
// fine-grained distinction lives once the category is fixed by the establishment.
export const SUBCATEGORY_RULE = `
ALWAYS assign the best-matching subcategory from the available sub_categories list to EVERY
item, inferring it from the item description when it is not stated explicitly (it almost never
is). Use fuzzy matching. Only omit the subcategory when no existing subcategory reasonably
matches the item — NEVER invent a subcategory that is not in the list.
`.trim();

// The store/merchant name is at the top of the receipt; reuse an existing
// location whenever one plausibly matches instead of creating near-duplicates.
export const LOCATION_RULE = `
ALWAYS check the existing locations list before outputting a location. Use fuzzy,
case-insensitive matching: receipts print full legal/uppercase store names, so
"SUPERMERCADO BROMBATTI LTDA" refers to an existing location named "Brombatti", and
"MERCADO SAO LUIZ LTDA" refers to "São Luiz". If any existing location plausibly refers to
the same place, output that existing location's name EXACTLY as it appears in the list.
Only output a new location name when nothing matches, and prefer a short, human-friendly name
(e.g. "Brombatti") over the full legal name printed on the receipt. All items extracted from
the same receipt MUST use the exact same location.
`.trim();
