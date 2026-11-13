/**
 * PilotPanel: LLM Tool Declarations
 * Schemas compliant with Gemini Function Calling specification.
 */

import { ToolDeclaration } from './provider';

export const PERCEPTION_TOOLS: ToolDeclaration[] = [
  {
    name: 'read_page',
    description:
      'Reads the page as a structured accessibility tree of elements with stable ref IDs. ' +
      'Use this to understand what elements exist, their roles, names, and current states.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filter: {
          type: 'STRING',
          enum: ['interactive', 'all'],
          description:
            'Choose "interactive" to see only buttons, links, inputs, and form controls (recommended). ' +
            'Choose "all" to inspect static headings, text containers, and structural elements.',
        },
        ref_id: {
          type: 'STRING',
          description:
            'Optional ref ID of an element (e.g. "ref_14") to read only its subtree instead of the entire page.',
        },
        max_depth: {
          type: 'INTEGER',
          description: 'Maximum DOM depth to traverse (1 to 15, default is 15).',
        },
      },
    },
  },
  {
    name: 'get_page_text',
    description:
      'Extracts the primary readable textual content of the active web page, stripping away boilerplate, navigation, and scripts.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'find',
    description:
      'Searches the current page for elements matching a natural language description (e.g. "blue checkout button", "email input"). ' +
      'Returns matching elements with their ref IDs, accessible names, roles, and viewport coordinates.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Natural language description of the element or elements to find.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'take_screenshot',
    description:
      'Captures a normalized screenshot of the current visible browser viewport along with scale factors.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];
