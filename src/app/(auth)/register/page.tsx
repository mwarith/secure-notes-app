import type { Metadata } from "next";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = {
  title: "Create your account",
};

export default function RegisterPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <RegisterForm />
    </main>
  );
}
