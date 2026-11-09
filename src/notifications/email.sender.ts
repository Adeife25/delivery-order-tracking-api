import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

@Injectable()
export class EmailSender {
  private readonly transporter?: Transporter;
  private readonly from: string;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST');
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');

    this.from = config.getOrThrow<string>('SMTP_FROM');

    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(config.getOrThrow<number>('SMTP_PORT')),
        secure: Boolean(config.getOrThrow<boolean>('SMTP_SECURE')),
        ...(user && { auth: { user, pass } }),
      });
    }
  }

  isEnabled(): boolean {
    return Boolean(this.transporter);
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.transporter) {
      return;
    }

    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
