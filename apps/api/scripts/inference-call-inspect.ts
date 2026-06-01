/**
 * E2.2 — inspect the most recent inference call's full audit trail.
 *
 * Useful right after a /v1/chat/completions test to confirm the
 * meter + TokenUsage + balance debit all landed and to identify
 * which user the API key belonged to (which is whose balance moved).
 *
 *   pnpm --filter @a2e/api inference-call:inspect
 *   pnpm --filter @a2e/api inference-call:inspect <inferenceRequestId>
 */
import { prisma } from '@a2e/database'

async function main(): Promise<void> {
  const argId = process.argv[2]

  const ir = argId
    ? await prisma.inferenceRequest.findUnique({ where: { id: argId } })
    : await prisma.inferenceRequest.findFirst({ orderBy: { createdAt: 'desc' } })

  if (!ir) {
    console.log('No InferenceRequest rows found.')
    return
  }

  console.log(`InferenceRequest ${ir.id}`)
  console.log(`  status:            ${ir.status}`)
  console.log(`  model:             ${ir.model}`)
  console.log(`  external provider: ${ir.externalProvider ?? '(none — served by worker)'}`)
  console.log(`  worker id:         ${ir.inferenceWorkerId ?? '(no worker)'}`)
  console.log(`  input tokens:      ${ir.inputTokens ?? '(n/a)'}`)
  console.log(`  output tokens:     ${ir.outputTokens ?? '(n/a)'}`)
  console.log(`  latency:           ${ir.latencyMs ?? '(n/a)'}ms`)
  console.log(`  cost (audit):      $${(ir.costUsd ?? 0).toFixed(8)}`)
  console.log(`  error:             ${ir.errorMessage ?? '(none)'}`)
  console.log(`  created:           ${ir.createdAt.toISOString()}`)
  console.log(`  completed:         ${ir.completedAt?.toISOString() ?? '(n/a)'}`)
  console.log()

  // Resolve the user this call was billed to + show their balance.
  const user = await prisma.user.findUnique({
    where: { id: ir.userId },
    select: {
      id: true,
      email: true,
      walletAddress: true,
      role: true,
      buyerBalance: {
        select: { balanceUsd: true, totalSpent: true, totalToppedUp: true, updatedAt: true },
      },
    },
  })

  console.log(`Billed user ${ir.userId}`)
  console.log(`  email:             ${user?.email ?? '(none)'}`)
  console.log(`  wallet:            ${user?.walletAddress ?? '(none)'}`)
  console.log(`  role:              ${user?.role}`)
  if (user?.buyerBalance) {
    console.log(`  balance:           $${user.buyerBalance.balanceUsd.toFixed(8)}`)
    console.log(`  lifetime spent:    $${user.buyerBalance.totalSpent.toFixed(8)}`)
    console.log(`  lifetime toppedup: $${user.buyerBalance.totalToppedUp.toFixed(8)}`)
    console.log(`  balance updated:   ${user.buyerBalance.updatedAt.toISOString()}`)
  } else {
    console.log(`  balance:           (no BuyerBalance row — user never funded)`)
  }
  console.log()

  // Find the matching TokenUsage row (the actual billing ledger entry).
  const usage = await prisma.tokenUsage.findFirst({
    where: { requestId: ir.id },
  })
  if (usage) {
    console.log(`TokenUsage ${usage.id}`)
    console.log(`  cost charged:      $${usage.costUsd.toFixed(8)}`)
    console.log(`  input tokens:      ${usage.inputTokens}`)
    console.log(`  output tokens:     ${usage.outputTokens}`)
    console.log(`  created:           ${usage.createdAt.toISOString()}`)
  } else if (ir.status === 'FAILED' || ir.status === 'CANCELLED') {
    console.log(`TokenUsage: not created (request ${ir.status} — buyer not billed)`)
  } else {
    console.log(`TokenUsage: NO ROW FOUND for requestId=${ir.id}`)
    console.log(`  This is a bug — meter should have created one. Check API logs.`)
  }
  console.log()

  // And the matching BalanceTransaction (the actual debit).
  const balance = user?.buyerBalance
    ? await prisma.buyerBalance.findUnique({
        where: { userId: ir.userId },
        select: { id: true },
      })
    : null
  if (balance) {
    const tx = await prisma.balanceTransaction.findFirst({
      where: {
        balanceId: balance.id,
        type: 'SPEND_INFERENCE',
        referenceId: ir.id,
      },
    })
    if (tx) {
      console.log(`BalanceTransaction ${tx.id}`)
      console.log(`  type:              ${tx.type}`)
      console.log(`  amount:            $${tx.amountUsd.toFixed(8)}`)
      console.log(`  balance after:     $${tx.balanceAfter.toFixed(8)}`)
      console.log(`  description:       ${tx.description}`)
      console.log(`  created:           ${tx.createdAt.toISOString()}`)
    } else if (ir.status === 'FAILED' || ir.status === 'CANCELLED') {
      console.log(`BalanceTransaction: not created (request ${ir.status} — buyer not billed, balance unchanged)`)
    } else {
      console.log(`BalanceTransaction: NO ROW FOUND for SPEND_INFERENCE/${ir.id}`)
      console.log(`  The meter call probably failed. Check API logs around ${ir.createdAt.toISOString()}.`)
    }
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
