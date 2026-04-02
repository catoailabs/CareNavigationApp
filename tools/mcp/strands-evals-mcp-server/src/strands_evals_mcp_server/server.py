from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, Field
import logging
from typing import Any

from strands_evals import Case, Experiment, ActorSimulator
import strands_evals.evaluators as evals_pkg

# Import the strands agent wrapper around perplexity agentic research API
from models.perplexity_agentic import create_research_lab_agent

logger = logging.getLogger(__name__)

mcp = FastMCP("strands-evals")

class SimulateActorRequest(BaseModel):
    scenario: str = Field(
        ..., description="The scenario context for the actor to follow"
    )
    history: list[dict] = Field(
        default_factory=list, description="Conversation history"
    )
    turns: int = Field(default=1, description="Number of turns to simulate")
    model_id: str | None = Field(default=None, description="Perplexity Agentic Model ID to use")

@mcp.tool()
def actor_simulator(request: SimulateActorRequest) -> dict:
    """Simulate an actor for multi-turn evaluations using Strands Evals SDK Simulator."""
    case = Case(
        name="simulation_case",
        input=request.scenario,
        expected_output=None,
    )
    
    # Initialize the Simulator by the book
    simulator = ActorSimulator.from_case_for_user_simulator(
        case=case,
        max_turns=request.turns,
    )
    
    simulated_messages = []
    
    # We take the previous AI message to generate the User's next turn.
    last_ai_message = "Hello! I'm your healthcare AI assistant. How can I help you today?"
    for msg in reversed(request.history):
        if msg.get("role") == "assistant":
            last_ai_message = msg.get("content", last_ai_message)
            break

    try:
        for _ in range(request.turns):
            if not simulator.has_next():
                break
                
            user_result = simulator.act(last_ai_message)
            
            if hasattr(user_result, "structured_output") and hasattr(user_result.structured_output, "message"):
                user_message = str(user_result.structured_output.message)
            elif hasattr(user_result, "output") and hasattr(user_result.output, "message"):
                user_message = str(user_result.output.message)
            elif hasattr(user_result, "message"):
                user_message = str(user_result.message)
            else:
                user_message = str(user_result)
                
            simulated_messages.append({"role": "user", "content": user_message})
            last_ai_message = "Acknowledged. Next question?"
            
    except Exception as e:
        logger.error(f"Simulator error: {e}")
        return {"status": "error", "message": str(e)}

    return {
        "status": "success",
        "scenario": request.scenario,
        "turns_completed": len(simulated_messages),
        "simulated_messages": simulated_messages,
    }

class ExperimentRequest(BaseModel):
    name: str = Field(..., description="Name of the experiment")
    dataset: list[dict] = Field(..., description="Dataset records to evaluate")
    evaluators: list[str] = Field(..., description="Names of evaluators to run")
    model_id: str | None = Field(default=None, description="Perplexity Agentic Model ID to use")

@mcp.tool()
def experiment_generator(request: ExperimentRequest) -> dict:
    """Generate and run an experiment Manager using Strands Evals SDK and Perplexity Agentic API."""
    cases = []
    for idx, record in enumerate(request.dataset):
        case_name = record.get("id", f"case_{idx}")
        cases.append(
            Case(
                name=case_name,
                input=record.get("input", record.get("prompt", "")),
                expected_output=record.get("expected_output", ""),
                expected_trajectory=record.get("expected_trajectory"),
                expected_interactions=record.get("expected_interactions"),
                metadata=record.get("metadata", {}),
            )
        )
        
    evaluator_instances = []
    for eval_name in request.evaluators:
        cls = getattr(evals_pkg, eval_name, None)
        if cls:
            try:
                # instantiate with dummy rubric if needed
                if eval_name in ["OutputEvaluator", "InteractionsEvaluator", "TrajectoryEvaluator"]:
                    evaluator_instances.append(cls(rubric="Evaluate correctness and medical accuracy"))
                else:
                    evaluator_instances.append(cls())
            except Exception as e:
                logger.warning(f"Could not instantiate {eval_name}: {e}")
                
    # Create the Experiment Manager by the book
    experiment = Experiment(cases=cases, evaluators=evaluator_instances)
    
    # 100% by the book task function wrapper utilizing Perplexity Agentic API
    # Since dataset generation uses this agent wrapper
    agent = create_research_lab_agent(
        model_id=request.model_id or "anthropic/claude-opus-4-6",
        system_prompt="You are a dataset generator assistant."
    )

    def agent_task(case: Case) -> dict[str, Any]:
        """Task function to be used by the Strands Experiment Manager."""
        # Use Perplexity wrapper to generate the expected outcome
        # If it's pure generation, we return what the agent outputs
        # Strands Evals SDK requires the task to return the output string or a dict
        try:
            # converse is synchronous wrapper inside PerplexityAgenticModel
            response = agent.model.converse(
                messages=[{"role": "user", "content": case.input}],
                system_prompt="You are generating SFT data."
            )
            return {
                "output": response.get("content", ""),
                "trajectory": response.get("function_calls", []),
                "interactions": [],
            }
        except Exception as e:
            logger.error(f"Task generation error: {e}")
            return {"output": "", "error": str(e)}

    try:
        reports = experiment.run_evaluations(agent_task)
    except Exception as e:
        logger.error(f"Experiment error: {e}")
        return {"status": "error", "message": str(e)}

    # Process reports
    avg_score = 0.0
    if reports:
        avg_score = sum(r.overall_score for r in reports) / len(reports)

    return {
        "status": "success",
        "experiment_name": request.name,
        "results": {
            "overall_score": avg_score,
            "reports_count": len(reports),
            "evaluators_used": request.evaluators
        },
    }

if __name__ == "__main__":
    mcp.run()
