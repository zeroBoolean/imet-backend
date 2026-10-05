import { z } from 'zod';
export const statuses = [
  'OPEN',
  'UNDER_REVIEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
] as const;
const params = z.object({ id: z.uuid() });
const text = (max: number) => z.string().trim().min(1).max(max);
export const ticketQuery = z
  .object({
    q: z.string().trim().max(100).default(''),
    status: z.enum(statuses).optional(),
    machineId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    assignedToId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    view: z.enum(['customer', 'assigned']).default('customer'),
  })
  .strict()
  .refine(
    (q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to),
    'Invalid date range',
  );
export type TicketQuery = z.infer<typeof ticketQuery>;
export const ticketCreate = z
  .object({
    saleId: z.uuid(),
    customerRequestId: z.uuid(),
    subject: text(200),
    description: text(10000),
    warrantyRequested: z.boolean().default(false),
  })
  .strict();
export type TicketCreate = z.infer<typeof ticketCreate>;
const version = { updatedAt: z.iso.datetime() };
export const ticketStatus = z
  .object({
    ...version,
    status: z.enum(['UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
    note: text(5000).optional(),
    resolution: text(5000).optional(),
  })
  .strict()
  .refine(
    (v) => v.status !== 'RESOLVED' || !!v.resolution,
    'Resolution is required',
  )
  .refine(
    (v) => v.status !== 'IN_PROGRESS' || !!v.note,
    'Describe the diagnosis or service work when starting',
  );
export type TicketStatusInput = z.infer<typeof ticketStatus>;
export const ticketNote = z
  .object({
    ...version,
    note: text(5000),
    visibility: z.enum(['PUBLIC', 'INTERNAL']).default('PUBLIC'),
  })
  .strict();
export const ticketAssignment = z
  .object({ ...version, assignedToId: z.uuid() })
  .strict();
export const ticketWarranty = z
  .object({
    ...version,
    assessment: z.enum(['APPROVED', 'DECLINED']),
    note: text(2000),
  })
  .strict();
export const ticketSchemas = {
  list: z.object({ query: ticketQuery }),
  id: z.object({ params }),
  create: z.object({ body: ticketCreate }),
  status: z.object({ params, body: ticketStatus }),
  note: z.object({ params, body: ticketNote }),
  assignment: z.object({ params, body: ticketAssignment }),
  warranty: z.object({ params, body: ticketWarranty }),
  events: z.object({
    params,
    query: z
      .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
  }),
  eligible: z.object({
    query: z
      .object({
        machine: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(220)
          .optional(),
        saleId: z.uuid().optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
  }),
};
