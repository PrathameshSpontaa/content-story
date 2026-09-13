'use server';

import { revalidatePath } from 'next/cache';
import { ReportError, cancelReport, requestReport } from '../../../../lib/reports.js';
import { requireSession } from '../../../../lib/session.js';

export async function requestReportAction(_previous, formData) {
  const session = await requireSession();
  try {
    const { quoted } = await requestReport(
      { workspaceId: session.workspace.id, userId: session.user.id },
      { query: formData.get('query'), platforms: formData.getAll('platforms'), dateFrom: formData.get('dateFrom'), dateTo: formData.get('dateTo') },
    );
    revalidatePath('/reports');
    return { ok: true, message: `Requested. ${quoted.toLocaleString('en-IN')} credits are on hold until your report is ready.` };
  } catch (err) {
    if (err instanceof ReportError) return { ok: false, message: err.message };
    console.error(err);
    return { ok: false, message: 'Something went wrong on our side. Nothing was charged; try again in a minute.' };
  }
}

export async function cancelReportAction(formData) {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  await cancelReport(session.workspace.id, id);
  revalidatePath('/reports');
}
