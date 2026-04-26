import { Request, Response, NextFunction } from "express";
import { objectIdSchema } from "../../shared/db/objectIdSchema.js";
import { orm } from "../../shared/db/orm.js";
import { z } from "zod";
import { Order, OrderStatus, PaymentProvider } from "./order.entity.js";
import {
  sanitizeOrderResponseArray,
  sanitizeOrderResponse,
} from "../../shared/entities/sanitizeOrderResponse.js";
import { OpenAI } from "openai";
import { sanitizeInput } from "../../shared/db/sanitizeInput.js";
import {
  ensureWandExists,
  ensureWizardExists,
} from "../../shared/db/ensureEntityExists.js";
import { Wand, WandStatus } from "../wand/wand.entity.js";
import { paginateEntity } from "../../shared/db/paginateEntity.js";

const em = orm.em;

const openai = new OpenAI({
  baseURL: process.env.OPENAI_ENDPOINT,
  apiKey: process.env.OPENAI_KEY,
});

const orderZodSchema = z.object({
  id: objectIdSchema.optional(),
  payment_reference: z.string().trim().min(1),
  payment_provider: z.nativeEnum(PaymentProvider),
  shipping_address: z.string().trim().min(1),
  wizard: objectIdSchema,
  wand: objectIdSchema,
});

const sanitizeOrderInput = sanitizeInput(orderZodSchema);

const orderReviewZodSchema = z.object({
  review: z.string().trim().min(1),
});

const sanitizeOrderReviewInput = sanitizeInput(orderReviewZodSchema);

async function findAll(req: Request, res: Response) {
  return paginateEntity(
    Order,
    em,
    req,
    res,
    {},
    ["wizard", "wizard.school", "wand", "wand.wood", "wand.core"],
    sanitizeOrderResponseArray,
  );
}

async function findAllByWizard(req: Request, res: Response) {
  return paginateEntity(Order, em, req, res, { wizard: req.params.wizardId }, [
    "wizard",
    "wizard.school",
    "wand",
    "wand.wood",
    "wand.core",
  ]);
}

async function findAllByWand(req: Request, res: Response) {
  return paginateEntity(Order, em, req, res, { wizard: req.params.wandId }, [
    "wizard",
    "wizard.school",
    "wand",
    "wand.wood",
    "wand.core",
  ]);
}

async function findOne(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const order = await em.findOneOrFail(
      Order,
      { id },
      {
        populate: ["wizard", "wizard.school", "wand", "wand.wood", "wand.core"],
      },
    );
    const sanitizedResponse = sanitizeOrderResponse(order);
    res.status(200).json({ message: "Order fetched", data: sanitizedResponse });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function add(req: Request, res: Response) {
  try {
    const input = req.body.sanitizedInput;

    if (!(await ensureWizardExists(em, input.wizard, res))) return;

    const wand = await ensureWandExists(em, input.wand, res);
    if (!wand) return;
    if (wand.status !== WandStatus.Available) {
      res.status(400).json({ message: "Wand is not available" });
      return;
    }

    input.created_at = Date();
    input.status = OrderStatus.Pending;
    input.completed = false;

    const order = em.create(Order, input);
    await em.flush();
    const sanitizedResponse = sanitizeOrderResponse(order);
    res.status(201).json({ message: "Order created", data: sanitizedResponse });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: "An error occurred while creating the order" });
  }
}

async function update(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const input = req.body.sanitizedInput;

    if (!(await ensureWizardExists(em, input.wizard, res))) return;
    if (!(await ensureWandExists(em, input.wand, res))) return;

    const orderToUpdate = await em.findOneOrFail(Order, id);
    em.assign(orderToUpdate, input);
    await em.flush();

    const sanitizedResponse = sanitizeOrderResponse(orderToUpdate);
    res.status(200).json({ message: "Order updated", data: sanitizedResponse });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function pay(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const orderToPay = await em.findOneOrFail(
      Order,
      { id },
      { populate: ["wand"] },
    );

    if (orderToPay.status !== OrderStatus.Pending) {
      res.status(400).json({ message: "Order is not in a payable state" });
      return;
    }

    // Here you would integrate with the payment provider
    // For example, using Stripe or PayPal SDKs

    orderToPay.status = OrderStatus.Paid;
    orderToPay.wand.status = WandStatus.Sold;
    await em.flush();
    const sanitizedResponse = sanitizeOrderResponse(orderToPay);
    res
      .status(200)
      .json({ message: "Order paid successfully", data: sanitizedResponse });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

function generateTrackingId(): string {
  return "TRK-" + Math.random().toString(36).slice(2, 10).toUpperCase();
}

function scheduleAutoDelivery(id: string) {
  const delay = 10000; // 10 seconds

  setTimeout(async () => {
    try {
      const order = await em.findOne(Order, { id });
      if (order && order.status === OrderStatus.Dispatched) {
        order.status = OrderStatus.Delivered;
        await em.flush();
      }
    } catch (err) {
      console.error("Auto-delivery failed:", err);
    }
  }, delay);
}

async function dispatch(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const orderToDispatch = await em.findOneOrFail(Order, { id });

    if (orderToDispatch.status !== OrderStatus.Paid) {
      res.status(400).json({ message: "Order is not in a dispatchable state" });
      return;
    }

    // Here you would integrate with the shipping provider
    // For example, using a shipping API to create a shipment

    orderToDispatch.tracking_id = generateTrackingId();
    orderToDispatch.status = OrderStatus.Dispatched;
    await em.flush();

    const sanitizedResponse = sanitizeOrderResponse(orderToDispatch);
    res
      .status(200)
      .json({
        message: "Order dispatched successfully",
        data: sanitizedResponse,
      });

    // Trigger fake delivery after dispatch
    scheduleAutoDelivery(id);
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function complete(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const orderToComplete = await em.findOneOrFail(Order, { id });

    if (orderToComplete.status !== OrderStatus.Delivered) {
      res.status(400).json({ message: "Order is not in a completable state" });
      return;
    }

    orderToComplete.status = OrderStatus.Completed;
    orderToComplete.completed = true;

    await em.flush();

    const sanitizedResponse = sanitizeOrderResponse(orderToComplete);
    res
      .status(200)
      .json({
        message: "Order completed successfully",
        data: sanitizedResponse,
      });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function cancel(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const orderToCancel = await em.findOneOrFail(
      Order,
      { id },
      { populate: ["wand"] },
    );

    if (
      orderToCancel.status === OrderStatus.Completed ||
      orderToCancel.status === OrderStatus.Refunded ||
      orderToCancel.status === OrderStatus.Pending
    ) {
      res
        .status(400)
        .json({ message: "Order cannot be cancelled at this stage" });
      return;
    }

    orderToCancel.status = OrderStatus.Cancelled;
    orderToCancel.wand.status = WandStatus.Deactivated;
    await em.flush();

    const sanitizedResponse = sanitizeOrderResponse(orderToCancel);
    res
      .status(200)
      .json({
        message: "Order cancelled successfully",
        data: sanitizedResponse,
      });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function refund(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const orderToRefund = await em.findOneOrFail(Order, { id });

    if (
      orderToRefund.status !== OrderStatus.Cancelled &&
      orderToRefund.status !== OrderStatus.Completed
    ) {
      res.status(400).json({ message: "Order is not in a refundable state" });
      return;
    }

    // Here you would integrate with the payment provider to process the refund
    // For example, using Stripe or PayPal SDKs

    orderToRefund.status = OrderStatus.Refunded;
    await em.flush();

    const sanitizedResponse = sanitizeOrderResponse(orderToRefund);
    res
      .status(200)
      .json({
        message: "Order refunded successfully",
        data: sanitizedResponse,
      });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

// Returns true if the review is safe, false if flagged
async function checkReviewWithOpenAI(reviewText: string): Promise<boolean> {
  const prompt = `
  You are a content moderation AI. Analyze the following product review and respond ONLY with "SAFE" if it is appropriate, or "UNSAFE" if it contains hate speech, violence, sexual content, or other inappropriate material.
  
  Review: """${reviewText}"""
  `;

  const response = await openai.chat.completions.create({
    model: "openai/gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "You are a strict content moderation assistant.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 1,
  });

  const content = response.choices[0].message.content?.trim().toUpperCase();
  return content === "SAFE";
}

async function review(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const orderToReview = await em.findOneOrFail(Order, { id });

    if (!orderToReview.completed || orderToReview.review) {
      res.status(400).json({ message: "Order is not in a reviewable state" });
      return;
    }

    const reviewInput = req.body.sanitizedInput;

    // Use the extracted function to check the review
    const isSafe = await checkReviewWithOpenAI(reviewInput.review);
    if (!isSafe) {
      res
        .status(400)
        .json({ message: "Review contains inappropriate content" });
      return;
    }

    orderToReview.review = reviewInput.review;
    await em.flush();

    const sanitizedResponse = sanitizeOrderResponse(orderToReview);
    res
      .status(200)
      .json({
        message: "Order reviewed successfully",
        data: sanitizedResponse,
      });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

async function remove(req: Request, res: Response) {
  try {
    const id = req.params.id;
    const orderToDelete = await em.findOneOrFail(Order, { id });
    await em.removeAndFlush(orderToDelete);
    res.status(200).json({ message: "Order deleted" });
  } catch (error: any) {
    if (error.name === "NotFoundError") {
      res.status(404).json({ message: "Order not found" });
    } else {
      res.status(500).json({ message: error.message });
    }
  }
}

export {
  sanitizeOrderInput,
  sanitizeOrderReviewInput,
  findAll,
  findAllByWizard,
  findAllByWand,
  findOne,
  add,
  update,
  pay,
  dispatch,
  complete,
  cancel,
  refund,
  review,
  remove,
};
