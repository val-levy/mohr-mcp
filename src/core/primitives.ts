import { z } from 'zod';

export const id = z.string().trim().min(1);
export const text = z.string().trim().min(1);
export const strings = z.array(text);
export const score = z.number().min(0).max(10);
export const confidence = z.number().min(0).max(1);
