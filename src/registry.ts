import type { Tool } from './core/envelope.js';
import { candidateTools } from './candidates/tools.js';
import { interviewTools } from './interviews/tools.js';
import { jobTools } from './jobs/tools.js';
import { skillTools } from './skills/tools.js';

export const tools: Tool[] = [...candidateTools, ...jobTools, ...interviewTools, ...skillTools];
