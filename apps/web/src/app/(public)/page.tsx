import Link from "next/link";

import { PageHeader } from "@/components/page-header";

export default function HomePage() {
  return (
    <>
      <PageHeader title="AI Habit Coach" description="習慣の記録と振り返りをひとつの場所で。" />
      <p>
        <Link href="/today">今日の記録へ</Link>
      </p>
    </>
  );
}
