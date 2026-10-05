import type { Tool } from '../tool.js';
import { candidateTools } from './candidates.js';
import { interviewTools } from './interviews.js';
import { jobTools } from './jobs.js';

export const tools: Tool[] = [...candidateTools, ...jobTools, ...interviewTools];
