import { Link } from "@ros/web/src/nav";
import { BrandMark } from "../components/BrandMark";

/** Unknown paths anywhere in the shell (the API and candidate pages return their own 404s): one card on the page's glow. */
export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-[460px] animate-enter [animation-fill-mode:backwards] rounded-[20px] border border-line bg-surface px-6 py-10 text-center shadow-sm sm:px-10">
        <div className="flex justify-center">
          <BrandMark />
        </div>
        <h1 className="mt-8 font-display text-[30px] font-bold leading-[1.1] tracking-[-0.035em] text-ink">That page does not exist</h1>
        <p className="mt-3 text-[15px] text-ink-2">It may have moved, or the link is old.</p>
        <div className="mt-7">
          <Link to="/" className="btn primary">Go to Home</Link>
        </div>
      </div>
    </main>
  );
}
