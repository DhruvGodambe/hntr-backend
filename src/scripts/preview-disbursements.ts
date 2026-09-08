import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { AdminPanelService } from '../services/adminPanel.service';

async function main() {
  await connectDB();
  const lead = await AdminPanelService.getLeadershipPreview();
  const ach = await AdminPanelService.getAchievementPreview();
  console.log(
    JSON.stringify(
      {
        leadership: {
          pool: lead.poolBalanceUSD,
          eligible: lead.eligibleCount,
          unpaid: lead.unpaidCount,
          protocolEth: lead.protocolEth,
          burnerEth: lead.burnerEth,
          hopNote: Boolean(lead.hopNote),
        },
        achievement: {
          pool: ach.poolBalanceUSD,
          pending: ach.pendingCount,
          review: ach.pendingReviewCount,
          pendingUsd: ach.totalPendingUSD,
          protocolEth: ach.protocolEth,
          burnerEth: ach.burnerEth,
        },
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
